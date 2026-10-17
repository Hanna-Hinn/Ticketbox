import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, type System } from "../../../src/main/composition.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { connectToTestDatabase, resetSchema, testDatabaseUrl } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));

// The real composition root against the test database: every adapter is the
// production one; only the connection string and the log level differ.
let system: System;

beforeAll(async () => {
  const client = await connectToTestDatabase();
  await resetSchema(client);
  await runMigrations(client, migrationsDir);
  await seed(client);
  await client.end();
  system = compose({
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: "redis://localhost:6379",
    PORT: 0,
    LOG_LEVEL: "silent",
  });
});

afterAll(async () => {
  await system.close();
});

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

  it("reports Redis down within the health bound and still closes promptly", async () => {
    const degraded = compose({
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: "redis://localhost:6390",
      PORT: 0,
      LOG_LEVEL: "silent",
    });

    const response = await degraded.app.inject({ url: "/health" });
    const started = Date.now();
    await degraded.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { postgres: "ok", redis: "down" },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("closes idempotently", async () => {
    const extra = compose({
      DATABASE_URL: testDatabaseUrl(),
      REDIS_URL: "redis://localhost:6379",
      PORT: 0,
      LOG_LEVEL: "silent",
    });

    await extra.close();

    await expect(extra.close()).resolves.toBeUndefined();
  });
});
