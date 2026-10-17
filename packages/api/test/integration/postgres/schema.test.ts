import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { SEED_EVENTS, seed } from "../../../src/infrastructure/postgres/seed.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";

// The schema's business rules live in CHECK and UNIQUE constraints. A dropped
// constraint is invisible to TypeScript and to every other test, so each one
// is observed here directly.

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

const firstEvent = SEED_EVENTS[0];
const firstTier = firstEvent?.tiers[0];
if (firstEvent === undefined || firstTier === undefined) {
  throw new Error("seed data has no tiers");
}
const eventId = firstEvent.id;
const tierId = firstTier.id;

let client: pg.Client;

beforeAll(async () => {
  client = await connectToTestDatabase();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
});

async function insertHold(token: string): Promise<void> {
  await client.query(
    `INSERT INTO holds (token, tier_id, qty, status, expires_at)
     VALUES ($1, $2, 1, 'active', now() + interval '2 minutes')`,
    [token, tierId],
  );
}

async function insertOrder(id: string, holdToken: string): Promise<void> {
  await client.query(
    `INSERT INTO orders (id, hold_token, email, total_cents) VALUES ($1, $2, 'a@b.c', 2000)`,
    [id, holdToken],
  );
}

describe("schema constraints", () => {
  it("rejects a tier with negative inventory", async () => {
    await expect(
      client.query(
        `INSERT INTO ticket_tiers (id, event_id, name, price_cents, total_qty)
         VALUES (gen_random_uuid(), $1, 'Bad', 100, -1)`,
        [eventId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects a hold for zero tickets", async () => {
    await expect(
      client.query(
        `INSERT INTO holds (token, tier_id, qty, status, expires_at)
         VALUES ('t-zero', $1, 0, 'active', now())`,
        [tierId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects a hold with an unknown status", async () => {
    await expect(
      client.query(
        `INSERT INTO holds (token, tier_id, qty, status, expires_at)
         VALUES ('t-bogus', $1, 1, 'bogus', now())`,
        [tierId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects an order item with a negative unit price", async () => {
    await insertHold("t-1");
    await insertOrder("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "t-1");

    await expect(
      client.query(
        `INSERT INTO order_items (id, order_id, tier_id, qty, unit_price_cents)
         VALUES (gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, 1, -1)`,
        [tierId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("allows at most one order per hold", async () => {
    await insertHold("t-2");
    await insertOrder("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "t-2");

    await expect(insertOrder("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "t-2")).rejects.toThrow(
      /unique constraint/,
    );
  });
});
