import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compose, type System } from "../../../src/main/composition.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { eventId } from "../../../src/domain/value-objects/Ids.js";
import { connectToTestDatabase, resetSchema, testDatabaseUrl } from "../support/database.js";
import { connectToTestRedis, testRedisUrl } from "../support/redis.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

// The real composition root against the test database: every adapter is the
// production one; only the connection string and the log level differ.
let system: System;
let redis: Redis;

beforeAll(async () => {
  redis = await connectToTestRedis();
  await redis.flushdb();
  const client = await connectToTestDatabase();
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
  await client.end();
  system = compose({
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    PORT: 0,
    LOG_LEVEL: "silent",
  });
});

afterAll(async () => {
  await system.close();
  await redis.quit();
});

// Every test owns its cache state, and the composed client must be ready
// before a test that expects the cache to be written.
beforeEach(async () => {
  await redis.flushdb();
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

  it("reports Redis down within the health bound and still closes promptly", async () => {
    const degraded = compose({
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: "redis://localhost:6390",
      PORT: 0,
      LOG_LEVEL: "silent",
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
    });

    await extra.close();

    await expect(extra.close()).resolves.toBeUndefined();
  });
});
