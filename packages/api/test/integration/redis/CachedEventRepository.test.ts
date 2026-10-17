import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventId, type EventId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgEventRepository } from "../../../src/infrastructure/postgres/PgEventRepository.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import type { EventRepository } from "../../../src/application/ports/EventRepository.js";
import type { Event } from "../../../src/domain/entities/Event.js";
import {
  CACHE_TTL_SECONDS,
  CachedEventRepository,
  REFRESH_MUTEX_MS,
} from "../../../src/infrastructure/redis/CachedEventRepository.js";
import { RedisCacheStats } from "../../../src/infrastructure/redis/RedisCacheStats.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { connectToTestDatabase, resetSchema } from "../support/database.js";
import { connectToTestRedis } from "../support/redis.js";

// Counts reads and answers slowly: without the delay the first miss fills
// the cache before the second GET and a stampede test proves nothing.
class SlowCountingRepository implements EventRepository {
  calls = 0;
  constructor(
    private readonly inner: EventRepository,
    private readonly delayMs: number,
  ) {}
  async findById(id: EventId): Promise<Event | null> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.findById(id);
  }
  listUpcoming(now: Date): Promise<readonly Event[]> {
    return this.inner.listUpcoming(now);
  }
}

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const JAZZ = eventId("11111111-1111-4111-8111-111111111111");
const UNKNOWN = eventId("00000000-0000-4000-8000-000000000000");

let db: pg.Client;
let redis: Redis;
let repo: CachedEventRepository;
let inner: SlowCountingRepository;

beforeAll(async () => {
  db = await connectToTestDatabase();
  await resetSchema(db);
  await runMigrations(db, migrationsDir);
  await seed(db);
  redis = await connectToTestRedis();
  inner = new SlowCountingRepository(new PgEventRepository(db), 50);
  repo = new CachedEventRepository(
    inner,
    redis,
    new RedisCacheStats(redis, pino({ level: "silent" })),
    pino({ level: "silent" }),
  );
});

afterAll(async () => {
  await redis.quit();
  await db.end();
});

beforeEach(async () => {
  await redis.flushdb();
  inner.calls = 0;
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

  it.each([1, 2, 3, 4, 5])(
    "fifty concurrent reads of a cold key reach the inner repository exactly once (run %i)",
    async () => {
      const reads = Array.from({ length: 50 }, () => repo.findById(JAZZ));

      const events = await Promise.all(reads);

      expect(events.every((event) => event?.name === "Rooftop Jazz Night")).toBe(true);
      expect(inner.calls).toBe(1);
    },
  );

  it.each([1, 2, 3, 4, 5])(
    "fifty concurrent reads of a cold unknown id reach the inner repository exactly once (run %i)",
    async () => {
      const reads = Array.from({ length: 50 }, () => repo.findById(UNKNOWN));

      const events = await Promise.all(reads);

      expect(events.every((event) => event === null)).toBe(true);
      expect(inner.calls).toBe(1);
      const ttlMs = await redis.pttl(keys.eventCache(UNKNOWN));
      expect(ttlMs).toBeGreaterThan(25_000);
      expect(ttlMs).toBeLessThanOrEqual(30_000);
    },
  );

  it("takes the refresh mutex with a bounded lifetime", async () => {
    await repo.findById(JAZZ);

    const ttlMs = await redis.pttl(keys.eventRefresh(JAZZ));

    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(REFRESH_MUTEX_MS);
  });

  it("reads an unknown id from Postgres once, then from the negative cache", async () => {
    expect(await repo.findById(UNKNOWN)).toBeNull();
    expect(await repo.findById(UNKNOWN)).toBeNull();
    expect(await repo.findById(UNKNOWN)).toBeNull();

    expect(inner.calls).toBe(1);
    const ttlMs = await redis.pttl(keys.eventCache(UNKNOWN));
    // Literal bounds: the plan says 30 s, and a comparison against the
    // constant would pass whatever the constant became.
    expect(ttlMs).toBeGreaterThan(25_000);
    expect(ttlMs).toBeLessThanOrEqual(30_000);
  });

  it("counts hits and misses in Redis", async () => {
    await repo.findById(JAZZ);
    await repo.findById(JAZZ);
    await repo.findById(JAZZ);

    // The counters are fire-and-forget, but they were written on the same
    // connection this MGET uses, and ioredis writes in FIFO order.
    expect(await redis.mget(keys.cacheStats.hits, keys.cacheStats.misses)).toEqual(["2", "1"]);
  });

  it("heals a corrupt entry: reads through and rewrites it", async () => {
    await redis.set(keys.eventCache(JAZZ), "{", "EX", 60);

    const event = await repo.findById(JAZZ);

    expect(event?.name).toBe("Rooftop Jazz Night");
    expect(await redis.get(keys.eventCache(JAZZ))).not.toBe("{");
  });
});
