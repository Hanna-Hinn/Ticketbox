import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type pg from "pg";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CreateHoldUseCase } from "../../../src/application/use-cases/CreateHold.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { PgHoldRepository } from "../../../src/infrastructure/postgres/PgHoldRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { RedisHoldStore } from "../../../src/infrastructure/redis/RedisHoldStore.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";
import { connectToTestRedis } from "../support/redis.js";

// The Acceptance line is about two stores agreeing, so this one file wires
// both real adapters by hand — the one place the "one adapter, one engine"
// shape of the integration level is set aside on purpose. composition.ts
// cannot be used until TB-025 exposes POST /holds.
const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const TOKEN = holdToken("11111111-1111-4111-8111-aaaaaaaaaaa1");

let db: pg.Client;
let redis: Redis;
let store: RedisHoldStore;
let mirror: PgHoldRepository;

beforeAll(async () => {
  db = await connectToTestDatabase();
  await resetSchema(db);
  await runMigrations(db, migrationsDir);
  await seed(db);
  redis = await connectToTestRedis();
  store = new RedisHoldStore(redis, pino({ level: "silent" }));
  mirror = new PgHoldRepository(db);
});

afterAll(async () => {
  await redis.quit();
  await db.end();
});

beforeEach(async () => {
  await db.query("BEGIN");
  await redis.flushdb();
  // Nothing seeds the live counter yet (TB-027); the test does.
  await redis.hset(keys.tier(GENERAL), "remaining", 1000);
});

afterEach(async () => {
  await db.query("ROLLBACK");
});

describe("a hold, in both stores", () => {
  it("is reserved in Redis and mirrored as an active row; released in Redis and marked released", async () => {
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const events = new PgEventRepository(db);
    const create = new CreateHoldUseCase(
      events,
      store,
      mirror,
      clock,
      new FixedTokenGenerator([TOKEN]),
      120_000,
    );
    const release = new ReleaseHoldUseCase(store, mirror);

    const computed = async (): Promise<number | undefined> =>
      (await events.findById(JAZZ))?.tiers.find((tier) => tier.id === GENERAL)?.remaining;

    const created = await create.execute({ eventId: JAZZ, tierId: GENERAL, qty: 2 });
    const computedWhileHeld = await computed();
    const live = await store.find(TOKEN);
    const row = await db.query<{ status: string }>("SELECT status FROM holds WHERE token = $1", [
      TOKEN,
    ]);
    const released = await release.execute({ token: TOKEN });
    const rowAfter = await db.query<{ status: string }>(
      "SELECT status FROM holds WHERE token = $1",
      [TOKEN],
    );

    expect(created).toEqual(expect.objectContaining({ ok: true, token: TOKEN, remaining: 998 }));
    expect(live?.qty.value).toBe(2);
    expect(row.rows[0]?.status).toBe("active");
    // The two stores agree on the number, not only the status.
    expect(computedWhileHeld).toBe(998);
    expect(released).toEqual({ released: true, tierId: GENERAL, remaining: 1000 });
    expect(await store.find(TOKEN)).toBeNull();
    expect(rowAfter.rows[0]?.status).toBe("released");
    expect(await computed()).toBe(1000);
  });
});
