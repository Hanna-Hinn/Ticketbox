import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compose, type System } from "../../../src/main/composition.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { seed, SEED_EVENTS } from "../../../src/infrastructure/postgres/seed.js";
import { seedLiveCounters } from "../../../src/infrastructure/redis/seedLiveCounters.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../src/domain/value-objects/Ids.js";
import { connectToTestDatabase, resetSchema, testDatabaseUrl } from "../support/database.js";
import { connectToTestRedis, testRedisUrl } from "../support/redis.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

// The real composition root against the test database: every adapter is the
// production one; only the connection string and the log level differ.
let system: System;
let redis: Redis;
let db: pg.Client;

beforeAll(async () => {
  redis = await connectToTestRedis();
  await redis.flushdb();
  db = await connectToTestDatabase();
  await resetSchema(db);
  await runMigrations(db, migrationsDir);
  await seed(db);
  system = compose({
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    PORT: 0,
    LOG_LEVEL: "silent",
    HOLD_TTL_MS: 120_000,
  });
});

afterAll(async () => {
  await system.close();
  await redis.quit();
  await db.end();
});

// Every test owns its cache state, and the composed client must be ready
// before a test that expects the cache to be written.
beforeEach(async () => {
  await redis.flushdb();
  // What `pnpm seed` does for dev and CI (TB-025): the live counters.
  await seedLiveCounters(
    redis,
    SEED_EVENTS.flatMap((event) => event.tiers),
  );
  await waitForReady();
});

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const health = await system.app.inject({ url: "/health" });
    if (health.json<{ checks: { redis: string } }>().checks.redis === "ok") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the composed Redis client never became ready");
}

describe("compose", () => {
  it("wires a system whose health check reaches Postgres and Redis", async () => {
    const response = await system.app.inject({ url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("serves the seeded events through the real repository and the computed count", async () => {
    const list = await system.app.inject({ url: "/events" });
    const one = await system.app.inject({ url: "/events/11111111-1111-4111-8111-111111111111" });

    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>()).toHaveLength(3);
    expect(one.json<{ tiers: { name: string; remaining: number }[] }>().tiers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "VIP", remaining: 0 })]),
    );
  });

  it("serves the second read of an event from the cache the root wired in", async () => {
    const jazz = eventId("11111111-1111-4111-8111-111111111111");
    await system.app.inject({ url: `/events/${jazz}` });
    const raw = await redis.get(keys.eventCache(jazz));
    expect(raw).not.toBeNull();
    await redis.set(
      keys.eventCache(jazz),
      JSON.stringify({ ...JSON.parse(raw ?? "{}"), name: "From the cache" }),
      "EX",
      300,
    );

    const second = await system.app.inject({ url: `/events/${jazz}` });

    expect(second.json<{ name: string }>().name).toBe("From the cache");
  });

  it("shows the live counter, not the cached count, for a tier the store knows", async () => {
    const jazz = eventId("11111111-1111-4111-8111-111111111111");
    const general = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
    await system.app.inject({ url: `/events/${jazz}` });
    expect(await redis.get(keys.eventCache(jazz))).not.toBeNull();
    await redis.hset(keys.tier(general), "remaining", 7);

    const response = await system.app.inject({ url: `/events/${jazz}` });

    // The cached event still says 1000; the store's 7 wins (ADR 0002), and
    // the tiers the store has never seen keep their computed count.
    const tiers = response.json<{ tiers: { id: string; remaining: number }[] }>().tiers;
    expect(tiers.find((tier) => tier.id === general)?.remaining).toBe(7);
    expect(tiers.filter((tier) => tier.id !== general).every((tier) => tier.remaining >= 0)).toBe(
      true,
    );
  });

  it("exposes the cache counters at /_stats", async () => {
    const jazz = eventId("11111111-1111-4111-8111-111111111111");
    await system.app.inject({ url: `/events/${jazz}` });
    await system.app.inject({ url: `/events/${jazz}` });

    // The INCRs and the MGET behind /_stats share the system's connection,
    // in FIFO order; nothing else makes them land first.
    const response = await system.app.inject({ url: "/_stats" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cache: { hits: 1, misses: 1, hitRatio: 0.5 } });
  });

  it("creates a hold through the real stack: Redis decides, Postgres records, the page shows the drop", async () => {
    const jazz = "11111111-1111-4111-8111-111111111111";
    const general = "11111111-1111-4111-8111-aaaaaaaaaaaa";
    const remainingOf = (page: { json: <T>() => T }): number | undefined =>
      page
        .json<{ tiers: { id: string; remaining: number }[] }>()
        .tiers.find((t) => t.id === general)?.remaining;

    const created = await system.app.inject({
      method: "POST",
      url: "/holds",
      payload: { eventId: jazz, tierId: general, qty: 2 },
    });
    const body = created.json<{ token: string; expiresAt: string; remaining: number }>();
    const page = await system.app.inject({ url: `/events/${jazz}` });
    const fetched = await system.app.inject({ url: `/holds/${body.token}` });
    const row = await db.query<{ status: string }>("SELECT status FROM holds WHERE token = $1", [
      body.token,
    ]);
    const released = await system.app.inject({ method: "DELETE", url: `/holds/${body.token}` });
    const rowAfter = await db.query<{ status: string }>(
      "SELECT status FROM holds WHERE token = $1",
      [body.token],
    );
    const pageAfter = await system.app.inject({ url: `/events/${jazz}` });

    expect(created.statusCode).toBe(201);
    expect(body).toMatchObject({ eventId: jazz, tierId: general, qty: 2, remaining: 998 });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(remainingOf(page)).toBe(998);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ token: body.token, eventId: jazz, qty: 2 });
    expect(fetched.json<{ remainingMs: number }>().remainingMs).toBeGreaterThan(0);
    expect(row.rows[0]?.status).toBe("active");
    expect(released.json()).toEqual({ released: true });
    expect(rowAfter.rows[0]?.status).toBe("released");
    expect(remainingOf(pageAfter)).toBe(1000);
  });

  it("answers 500, not 404, for a live hold key the current script did not write", async () => {
    // The hash shape changed in TB-025 (eventId). A pre-upgrade key is a bug
    // to surface, not an expired hold to report.
    const token = "11111111-1111-4111-8111-aaaaaaaaaaa1";
    const createdAt = Date.now();
    await redis.hset(keys.hold(holdToken(token)), {
      tierId: "11111111-1111-4111-8111-aaaaaaaaaaaa",
      qty: 1,
      createdAt,
      expiresAt: createdAt + 120_000,
    });

    const response = await system.app.inject({ url: `/holds/${token}` });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL" } });
  });

  it("refuses with 409 INSUFFICIENT when the live counter says no", async () => {
    const vip = "11111111-1111-4111-8111-cccccccccccc";

    const response = await system.app.inject({
      method: "POST",
      url: "/holds",
      payload: { eventId: "11111111-1111-4111-8111-111111111111", tierId: vip, qty: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "INSUFFICIENT" } });
  });

  it("reports Redis down within the health bound and still closes promptly", async () => {
    const degraded = compose({
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: "redis://localhost:6390",
      PORT: 0,
      LOG_LEVEL: "silent",
      HOLD_TTL_MS: 120_000,
    });

    const response = await degraded.app.inject({ url: "/health" });
    const stats = await degraded.app.inject({ url: "/_stats" });
    const started = Date.now();
    await degraded.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { postgres: "ok", redis: "down" },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toEqual({ cache: { hits: 0, misses: 0, hitRatio: 0 } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("closes idempotently", async () => {
    const extra = compose({
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      PORT: 0,
      LOG_LEVEL: "silent",
      HOLD_TTL_MS: 120_000,
    });

    await extra.close();

    await expect(extra.close()).resolves.toBeUndefined();
  });
});
