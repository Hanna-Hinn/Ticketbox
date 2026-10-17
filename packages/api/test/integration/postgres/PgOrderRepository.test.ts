import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Order } from "../../../src/domain/entities/Order.js";
import { IdempotencyKeyReused } from "../../../src/domain/errors/IdempotencyKeyReused.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { eventId, orderId, tierId } from "../../../src/domain/value-objects/Ids.js";
import { Money } from "../../../src/domain/value-objects/Money.js";
import { Quantity } from "../../../src/domain/value-objects/Quantity.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { PgHoldRepository } from "../../../src/infrastructure/postgres/PgHoldRepository.js";
import { PgOrderRepository } from "../../../src/infrastructure/postgres/PgOrderRepository.js";
import { createPool } from "../../../src/infrastructure/postgres/pool.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { aHold } from "../../fakes/builders.js";
import { connectToTestDatabase, resetSchema, testDatabaseUrl } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("11111111-1111-4111-8111-aaaaaaaaaaa1");
const OTHER_TOKEN = holdToken("11111111-1111-4111-8111-aaaaaaaaaaa2");

// The adapter owns its transaction, so the sibling BEGIN/ROLLBACK-per-test
// isolation cannot wrap it: a real pool, and the three tables emptied
// before every case.
let admin: pg.Client;
let pool: pg.Pool;
let orders: PgOrderRepository;
let holds: PgHoldRepository;
let events: PgEventRepository;

function anOrder(
  token = TOKEN,
  overrides: { tier?: string; key?: string; id?: string } = {},
): Order {
  return Order.create({
    id: orderId(overrides.id ?? "22222222-2222-4222-8222-000000000001"),
    holdToken: token,
    email: "hanna@example.com",
    items: [
      {
        tierId: tierId(overrides.tier ?? GENERAL),
        qty: Quantity.of(2),
        unitPrice: Money.fromCents(2000),
      },
    ],
    createdAt: new Date("2026-01-01T10:00:30.000Z"),
    ...(overrides.key === undefined ? {} : { idempotencyKey: overrides.key }),
  });
}

async function heldRow(token = TOKEN): Promise<void> {
  await holds.save(
    aHold()
      .forTier(GENERAL)
      .withToken(token)
      .withQty(2)
      .createdAt("2026-01-01T10:00:00.000Z")
      .build(),
  );
}

async function count(table: string): Promise<number> {
  return Number(
    (await admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
  );
}

async function generalRemaining(): Promise<number | undefined> {
  const event = await events.findById(JAZZ);
  return event?.tiers.find((tier) => tier.id === GENERAL)?.remaining;
}

beforeAll(async () => {
  admin = await connectToTestDatabase();
  await resetSchema(admin);
  await runMigrations(admin, migrationsDir);
  await seed(admin);
  pool = createPool(testDatabaseUrl());
  orders = new PgOrderRepository(pool);
  holds = new PgHoldRepository(pool);
  events = new PgEventRepository(pool);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

beforeEach(async () => {
  await admin.query("TRUNCATE order_items, orders, holds");
});

describe("PgOrderRepository.save", () => {
  it("lands the order, its items and the hold's conversion together, and the computed count does not move", async () => {
    await heldRow();
    const before = await generalRemaining();

    await orders.save(anOrder(TOKEN, { key: "client-key-1" }));

    const order = await admin.query<{
      hold_token: string;
      email: string;
      total_cents: number;
      idempotency_key: string;
    }>("SELECT hold_token, email, total_cents, idempotency_key FROM orders");
    const items = await admin.query<{ tier_id: string; qty: number; unit_price_cents: number }>(
      "SELECT tier_id, qty, unit_price_cents FROM order_items",
    );
    const row = await admin.query<{ status: string }>("SELECT status FROM holds WHERE token = $1", [
      TOKEN,
    ]);
    expect(order.rows).toEqual([
      {
        hold_token: TOKEN,
        email: "hanna@example.com",
        total_cents: 4000,
        idempotency_key: "client-key-1",
      },
    ]);
    expect(items.rows).toEqual([{ tier_id: GENERAL, qty: 2, unit_price_cents: 2000 }]);
    expect(row.rows[0]?.status).toBe("converted");
    // Held → sold: the same number, subtracted from a different column.
    expect(before).toBe(998);
    expect(await generalRemaining()).toBe(998);
  });

  it("writes nothing for a hold whose row is not active", async () => {
    await heldRow();
    await holds.setStatus(TOKEN, "expired");

    await expect(orders.save(anOrder())).rejects.toThrow(/no active row/);

    expect(await count("orders")).toBe(0);
    expect(await count("order_items")).toBe(0);
    expect(
      (await admin.query<{ status: string }>("SELECT status FROM holds")).rows[0]?.status,
    ).toBe("expired");
  });

  it("writes nothing for a hold with no row at all", async () => {
    await expect(orders.save(anOrder())).rejects.toThrow(/no active row/);

    expect(await count("orders")).toBe(0);
  });

  it("leaves no partial order when a statement fails mid-transaction", async () => {
    // The hold's flip and the order succeed; the item names a tier that
    // does not exist. All three unwind.
    await heldRow();

    await expect(
      orders.save(anOrder(TOKEN, { tier: "99999999-9999-4999-8999-999999999999" })),
    ).rejects.toThrow();

    expect(await count("orders")).toBe(0);
    expect(await count("order_items")).toBe(0);
    expect(
      (await admin.query<{ status: string }>("SELECT status FROM holds")).rows[0]?.status,
    ).toBe("active");
  });

  it("refuses a reused idempotency key as the domain's own error, writing nothing", async () => {
    await heldRow();
    await heldRow(OTHER_TOKEN);
    await orders.save(anOrder(TOKEN, { key: "client-key-1" }));

    await expect(
      orders.save(
        anOrder(OTHER_TOKEN, { key: "client-key-1", id: "22222222-2222-4222-8222-000000000002" }),
      ),
    ).rejects.toThrow(IdempotencyKeyReused);

    expect(await count("orders")).toBe(1);
    expect(
      (
        await admin.query<{ status: string }>("SELECT status FROM holds WHERE token = $1", [
          OTHER_TOKEN,
        ])
      ).rows[0]?.status,
    ).toBe("active");
  });

  it("refuses a second order for the same hold at the guard, before the unique constraint", async () => {
    await heldRow();
    await orders.save(anOrder());

    await expect(
      orders.save(anOrder(TOKEN, { id: "22222222-2222-4222-8222-000000000002" })),
    ).rejects.toThrow(/no active row/);

    expect(await count("orders")).toBe(1);
  });

  it("lets exactly one of a confirm and an expiry land on the same row", async () => {
    await heldRow();

    const [saved, expired] = await Promise.allSettled([
      orders.save(anOrder()),
      holds.setStatus(TOKEN, "expired"),
    ]);
    const status = (await admin.query<{ status: string }>("SELECT status FROM holds")).rows[0]
      ?.status;

    expect(expired.status).toBe("fulfilled");
    if (saved.status === "fulfilled") {
      expect(status).toBe("converted");
      expect(await count("orders")).toBe(1);
    } else {
      expect(status).toBe("expired");
      expect(await count("orders")).toBe(0);
    }
  });

  it("does not cost the pool a connection for every refused key", async () => {
    await heldRow();
    await orders.save(anOrder(TOKEN, { key: "client-key-1" }));
    const before = pool.totalCount;

    for (let i = 0; i < 5; i += 1) {
      await heldRow(holdToken(`11111111-1111-4111-8111-aaaaaaaaaab${i}`));
      await orders
        .save(
          anOrder(holdToken(`11111111-1111-4111-8111-aaaaaaaaaab${i}`), {
            key: "client-key-1",
            id: `22222222-2222-4222-8222-00000000001${i}`,
          }),
        )
        .catch(() => undefined);
    }

    expect(pool.totalCount).toBeLessThanOrEqual(before + 1);
  });
});
