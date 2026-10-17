import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hold } from "../../../src/domain/entities/Hold.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { PgHoldRepository } from "../../../src/infrastructure/postgres/PgHoldRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { aHold } from "../../fakes/builders.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

// Seeded ids: Rooftop Jazz Night, General 1000 of 1000.
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("11111111-1111-4111-8111-aaaaaaaaaaa1");

interface HoldRow {
  token: string;
  tier_id: string;
  qty: number;
  status: string;
  expires_at: Date;
  created_at: Date;
}

let client: pg.Client;
let repo: PgHoldRepository;
let events: PgEventRepository;

function held(qty = 2): Hold {
  return aHold()
    .forTier(GENERAL)
    .withToken(TOKEN)
    .withQty(qty)
    .createdAt("2026-01-01T10:00:00.123Z")
    .withTtl(120_000)
    .build();
}

async function rowOf(token: string): Promise<HoldRow | undefined> {
  const result = await client.query<HoldRow>("SELECT * FROM holds WHERE token = $1", [token]);
  return result.rows[0];
}

async function generalRemaining(): Promise<number | undefined> {
  const event = await events.findById(JAZZ);
  return event?.tiers.find((tier) => tier.id === GENERAL)?.remaining;
}

// One migrate + seed, then every test inside its own rolled-back transaction.
beforeAll(async () => {
  client = await connectToTestDatabase();
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
  repo = new PgHoldRepository(client);
  events = new PgEventRepository(client);
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("PgHoldRepository", () => {
  it("writes the hold as an active row with the hold's own instants", async () => {
    const hold = held(2);

    await repo.save(hold);

    const row = await rowOf(TOKEN);
    expect(row).toMatchObject({ token: TOKEN, tier_id: GENERAL, qty: 2, status: "active" });
    expect(row?.created_at).toEqual(hold.createdAt);
    expect(row?.expires_at).toEqual(hold.expiresAt);
  });

  it("marks a row released, and keeps that first outcome against a later expired", async () => {
    await repo.save(held());

    await repo.setStatus(TOKEN, "released");
    const afterRelease = (await rowOf(TOKEN))?.status;
    await repo.setStatus(TOKEN, "expired");

    expect(afterRelease).toBe("released");
    expect((await rowOf(TOKEN))?.status).toBe("released");
  });

  it("keeps the first outcome in the other direction too: expired stays expired", async () => {
    await repo.save(held());

    await repo.setStatus(TOKEN, "expired");
    await repo.setStatus(TOKEN, "released");

    expect((await rowOf(TOKEN))?.status).toBe("expired");
  });

  it("accepts the same outcome twice without complaint", async () => {
    // The sweeper and a retried release will both do this.
    await repo.save(held());

    await repo.setStatus(TOKEN, "released");
    await expect(repo.setStatus(TOKEN, "released")).resolves.toBeUndefined();

    expect((await rowOf(TOKEN))?.status).toBe("released");
  });

  it("treats a status change for a token it never saw as a no-op, not an error", async () => {
    await expect(repo.setStatus(holdToken("tok-nobody"), "released")).resolves.toBeUndefined();

    expect(await rowOf("tok-nobody")).toBeUndefined();
  });

  it("refuses to save the same token twice: that is a bug, not a value", async () => {
    await repo.save(held());

    await expect(repo.save(held())).rejects.toThrow(/duplicate key/);
  });

  it("refuses a hold for a tier that does not exist", async () => {
    const orphan = aHold()
      .forTier("00000000-0000-4000-8000-000000000000")
      .withToken("tok-orphan")
      .build();

    await expect(repo.save(orphan)).rejects.toThrow(/foreign key/);
  });

  it("moves the computed count: an active row counts as held, a released one does not", async () => {
    const before = await generalRemaining();

    await repo.save(held(3));
    const whileHeld = await generalRemaining();
    await repo.setStatus(TOKEN, "released");
    const afterRelease = await generalRemaining();

    expect(before).toBe(1000);
    expect(whileHeld).toBe(997);
    expect(afterRelease).toBe(1000);
  });
});
