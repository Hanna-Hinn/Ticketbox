import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import {
  CACHE_TTL_SECONDS,
  CachedEventRepository,
} from "../../../src/infrastructure/redis/CachedEventRepository.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";
import { connectToTestRedis } from "../support/redis.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");

let db: pg.Client;
let redis: Redis;
let repo: CachedEventRepository;

beforeAll(async () => {
  db = await connectToTestDatabase();
  await resetSchema(db);
  await runMigrations(db, migrationsDir);
  await seed(db);
  redis = await connectToTestRedis();
  repo = new CachedEventRepository(new PgEventRepository(db), redis, pino({ level: "silent" }));
});

afterAll(async () => {
  await redis.quit();
  await db.end();
});

beforeEach(async () => {
  await redis.flushdb();
});

describe("CachedEventRepository against Redis", () => {
  it("writes the event under its key with the documented TTL", async () => {
    await repo.findById(JAZZ);

    const ttlMs = await redis.pttl(keys.eventCache(JAZZ));

    expect(ttlMs).toBeGreaterThan((CACHE_TTL_SECONDS - 5) * 1000);
    expect(ttlMs).toBeLessThanOrEqual(CACHE_TTL_SECONDS * 1000);
  });

  it("serves the second read from the cache, not Postgres", async () => {
    await repo.findById(JAZZ);
    // Rewrite the cached name by hand: only a read that comes from Redis sees it.
    const raw = await redis.get(keys.eventCache(JAZZ));
    expect(raw).not.toBeNull();
    const edited = { ...JSON.parse(raw ?? "{}"), name: "From the cache" };
    await redis.set(keys.eventCache(JAZZ), JSON.stringify(edited), "EX", CACHE_TTL_SECONDS);

    const event = await repo.findById(JAZZ);

    expect(event?.name).toBe("From the cache");
  });

  it("invalidation removes the key", async () => {
    await repo.findById(JAZZ);

    await repo.invalidate(JAZZ);

    expect(await redis.exists(keys.eventCache(JAZZ))).toBe(0);
  });

  it("heals a corrupt entry: reads through and rewrites it", async () => {
    await redis.set(keys.eventCache(JAZZ), "{", "EX", 60);

    const event = await repo.findById(JAZZ);

    expect(event?.name).toBe("Rooftop Jazz Night");
    expect(await redis.get(keys.eventCache(JAZZ))).not.toBe("{");
  });
});
