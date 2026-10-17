import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventId, tierId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

// Seeded ids (infrastructure/postgres/seed.ts). Rooftop Jazz Night: General
// 1000, Balcony 200, VIP 0 (sold out by construction).
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const BALCONY = tierId("11111111-1111-4111-8111-bbbbbbbbbbbb");
const VIP = tierId("11111111-1111-4111-8111-cccccccccccc");
const UNKNOWN = eventId("00000000-0000-4000-8000-000000000000");

let client: pg.Client;
let repo: PgEventRepository;

// One migrate + seed, then every test inside its own transaction on the same
// connection, rolled back afterwards: the handbook's isolation rule, which is
// why the repository accepts a ClientBase and not only a Pool.
beforeAll(async () => {
  client = await connectToTestDatabase();
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
  repo = new PgEventRepository(client);
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

async function insertHold(token: string, tier: string, qty: number, status: string): Promise<void> {
  await client.query(
    `INSERT INTO holds (token, tier_id, qty, status, expires_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
    [token, tier, qty, status],
  );
}

async function insertOrderFor(holdToken: string, tier: string, qty: number): Promise<void> {
  await client.query(
    `INSERT INTO orders (id, hold_token, email, total_cents)
     VALUES (gen_random_uuid(), $1, 'a@b.c', 0)`,
    [holdToken],
  );
  await client.query(
    `INSERT INTO order_items (id, order_id, tier_id, qty, unit_price_cents)
     SELECT gen_random_uuid(), o.id, $2, $3, 2000 FROM orders o WHERE o.hold_token = $1`,
    [holdToken, tier, qty],
  );
}

async function remainingOf(tier: string): Promise<number | undefined> {
  const event = await repo.findById(JAZZ);
  return event?.tiers.find((t) => t.id === tier)?.remaining;
}

describe("PgEventRepository", () => {
  it("finds a seeded event with its tiers as domain entities", async () => {
    const event = await repo.findById(JAZZ);

    expect(event?.name).toBe("Rooftop Jazz Night");
    expect(event?.venue).toBe("The Terrace, Ramallah");
    expect(event?.startsAt).toBeInstanceOf(Date);
    expect(event?.tiers.map((t) => [t.id, t.name, t.price.cents, t.total, t.remaining])).toEqual([
      [GENERAL, "General", 2000, 1000, 1000],
      [BALCONY, "Balcony", 3500, 200, 200],
      [VIP, "VIP", 8000, 0, 0],
    ]);
    expect(event?.tiers.every((t) => t.eventId === JAZZ)).toBe(true);
  });

  it("returns null for a well-formed id that matches nothing", async () => {
    expect(await repo.findById(UNKNOWN)).toBeNull();
  });

  it("lets a malformed id surface as a driver error, not as null", async () => {
    // UUID shape is the boundary's job (TB-011); the repository does not
    // paper over it. The transaction is aborted after this; afterEach rolls
    // it back, so nothing else runs in this test.
    await expect(repo.findById(eventId("not-a-uuid"))).rejects.toMatchObject({ code: "22P02" });
  });

  it("computes availability as total minus order items minus active holds", async () => {
    await insertHold("active", GENERAL, 5, "active");
    await insertHold("converted", GENERAL, 3, "converted");
    await insertOrderFor("converted", GENERAL, 3);
    await insertHold("released", GENERAL, 7, "released");
    await insertHold("expired", GENERAL, 9, "expired");

    expect(await remainingOf(GENERAL)).toBe(1000 - 5 - 3);
  });

  it("still counts an active hold whose expires_at has passed: the sweeper, not this query, decides", async () => {
    // insertHold writes expires_at one minute in the past.
    await insertHold("stale", BALCONY, 4, "active");

    expect(await remainingOf(BALCONY)).toBe(196);
  });

  it("reports 0, never negative, when sales exceed the total", async () => {
    await insertHold("oversold", VIP, 1, "converted");
    await insertOrderFor("oversold", VIP, 1);

    expect(await remainingOf(VIP)).toBe(0);
  });

  it("reports remaining = total when a tier has no orders and no holds at all", async () => {
    // GREATEST(0, total - NULL) is 0, not total: the COALESCEs are load-bearing.
    expect(await remainingOf(GENERAL)).toBe(1000);
  });

  it("orders tiers deterministically when prices tie", async () => {
    await client.query(
      `INSERT INTO ticket_tiers (id, event_id, name, price_cents, total_qty) VALUES
         ('11111111-1111-4111-8111-000000000003', $1, 'Tie C', 2000, 10),
         ('11111111-1111-4111-8111-000000000001', $1, 'Tie A', 2000, 10),
         ('11111111-1111-4111-8111-000000000002', $1, 'Tie B', 2000, 10)`,
      [JAZZ],
    );

    const event = await repo.findById(JAZZ);

    // Ties break on id, and 0000… sorts before the seeded General's aaaa….
    expect(event?.tiers.filter((t) => t.price.cents === 2000).map((t) => t.name)).toEqual([
      "Tie A",
      "Tie B",
      "Tie C",
      "General",
    ]);
  });

  it("loads an event with no tiers as an Event with an empty tier list", async () => {
    await client.query(
      `INSERT INTO events (id, name, venue, starts_at)
       VALUES ($1, 'Empty', 'Nowhere', now() + interval '1 day')`,
      [UNKNOWN],
    );

    const event = await repo.findById(UNKNOWN);

    expect(event?.name).toBe("Empty");
    expect(event?.tiers).toEqual([]);
  });

  describe("listUpcoming", () => {
    // The seed's starts_at is "7 weeks after seeding", which stops being
    // upcoming eventually; the tests pin their own instants instead.
    const t0 = new Date("2030-01-01T10:00:00.000Z");

    it("returns only events starting strictly after now, oldest first, with tiers", async () => {
      await client.query("DELETE FROM ticket_tiers; DELETE FROM events;");
      await client.query(
        `INSERT INTO events (id, name, venue, starts_at) VALUES
           ('00000000-0000-4000-8000-000000000002', 'Later',   'v', $1::timestamptz + interval '2 hours'),
           ('00000000-0000-4000-8000-000000000001', 'Sooner',  'v', $1::timestamptz + interval '1 hour'),
           ('00000000-0000-4000-8000-000000000003', 'At now',  'v', $1::timestamptz),
           ('00000000-0000-4000-8000-000000000004', 'Past',    'v', $1::timestamptz - interval '1 hour')`,
        [t0],
      );
      await client.query(
        `INSERT INTO ticket_tiers (id, event_id, name, price_cents, total_qty)
         VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'General', 1000, 50)`,
      );

      const upcoming = await repo.listUpcoming(t0);

      expect(upcoming.map((e) => [e.name, e.tiers.length])).toEqual([
        ["Sooner", 1],
        ["Later", 0],
      ]);
    });

    it("breaks a starts_at tie by id", async () => {
      await client.query("DELETE FROM ticket_tiers; DELETE FROM events;");
      await client.query(
        `INSERT INTO events (id, name, venue, starts_at) VALUES
           ('00000000-0000-4000-8000-000000000002', 'B', 'v', $1::timestamptz + interval '1 hour'),
           ('00000000-0000-4000-8000-000000000001', 'A', 'v', $1::timestamptz + interval '1 hour')`,
        [t0],
      );

      expect((await repo.listUpcoming(t0)).map((e) => e.name)).toEqual(["A", "B"]);
    });

    it("returns an empty list, not null, when nothing is upcoming", async () => {
      // No mutation of the repository makes this red (an empty ANY('{}') also
      // returns no rows); it pins the shape of the empty result.
      expect(await repo.listUpcoming(new Date("2999-01-01T00:00:00.000Z"))).toEqual([]);
    });
  });
});
