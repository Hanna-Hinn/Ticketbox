import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { SEED_EVENTS, seed } from "../../../src/infrastructure/postgres/seed.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

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
});

async function counts(): Promise<{ events: number; tiers: number }> {
  const result = await client.query<{ events: string; tiers: string }>(
    "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM ticket_tiers) AS tiers",
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("count query returned no row");
  return { events: Number(row.events), tiers: Number(row.tiers) };
}

describe("seed", () => {
  it("inserts 3 events with 3 tiers each, exactly one of them sold out", async () => {
    const inserted = await seed(client);

    expect(inserted).toEqual({ events: 3, tiers: 9 });
    expect(await counts()).toEqual({ events: 3, tiers: 9 });
    const soldOut = await client.query("SELECT 1 FROM ticket_tiers WHERE total_qty = 0");
    expect(soldOut.rowCount).toBe(1);
    const orphans = await client.query(
      "SELECT 1 FROM ticket_tiers t LEFT JOIN events e ON e.id = t.event_id WHERE e.id IS NULL",
    );
    expect(orphans.rowCount).toBe(0);
  });

  it("inserts nothing on a second run", async () => {
    await seed(client);

    const inserted = await seed(client);

    expect(inserted).toEqual({ events: 0, tiers: 0 });
    expect(await counts()).toEqual({ events: 3, tiers: 9 });
  });

  it("restores exactly the missing rows of a partially seeded database", async () => {
    await seed(client);
    const firstEvent = SEED_EVENTS[0];
    const missingTier = firstEvent?.tiers[0];
    if (missingTier === undefined) throw new Error("seed data has no tiers");
    await client.query("DELETE FROM ticket_tiers WHERE id = $1", [missingTier.id]);

    const inserted = await seed(client);

    expect(inserted).toEqual({ events: 0, tiers: 1 });
    expect(await counts()).toEqual({ events: 3, tiers: 9 });
  });

  it("seeds every event in the future, so they are upcoming", async () => {
    await seed(client);

    const past = await client.query("SELECT 1 FROM events WHERE starts_at <= now()");

    expect(past.rowCount).toBe(0);
  });
});
