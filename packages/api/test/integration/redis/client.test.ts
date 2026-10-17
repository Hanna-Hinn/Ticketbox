import type { Redis } from "ioredis";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRedisClient } from "../../../src/infrastructure/redis/client.js";
import { connectToTestRedis, testRedisUrl } from "../support/redis.js";

// A logger whose output the test can read: the lifecycle lines are the
// deliverable, not a side effect.
function capturingLogger(): { log: pino.Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const log = pino({ level: "info" }, { write: (chunk: string) => void chunks.push(chunk) });
  return { log, lines: () => chunks };
}

function once(client: Redis, event: string): Promise<void> {
  return new Promise((resolve) => client.once(event, () => resolve()));
}

let admin: Redis;

beforeAll(async () => {
  admin = await connectToTestRedis();
});

afterAll(async () => {
  await admin.quit();
});

beforeEach(async () => {
  await admin.flushdb();
});

describe("createRedisClient", () => {
  let client: Redis;

  afterEach(async () => {
    await client.quit().catch(() => undefined);
  });

  it("connects and answers a ping", async () => {
    client = createRedisClient(testRedisUrl(), pino({ level: "silent" }));

    const pong = await client.ping();

    expect(pong).toBe("PONG");
  });

  it("round-trips a value through set and get", async () => {
    client = createRedisClient(testRedisUrl(), pino({ level: "silent" }));

    await client.set("probe", "value");

    expect(await client.get("probe")).toBe("value");
  });

  it("starts each test with an empty database", async () => {
    client = createRedisClient(testRedisUrl(), pino({ level: "silent" }));

    expect(await client.get("probe")).toBeNull();
  });

  it("survives its connection being killed: logs, reconnects, and answers again", async () => {
    const { log, lines } = capturingLogger();
    client = createRedisClient(testRedisUrl(), log);
    await once(client, "ready");
    const reconnecting = once(client, "reconnecting");
    const readyAgain = once(client, "ready");

    await admin.client("KILL", "ID", await client.client("ID"));
    await reconnecting;
    await readyAgain;

    expect(await client.ping()).toBe("PONG");
    expect(lines().join("")).toContain("redis reconnecting");
    expect(lines().join("")).toContain("redis ready");
  });

  it("logs a connection error instead of crashing the process", async () => {
    const { log, lines } = capturingLogger();
    const dead = new URL(testRedisUrl());
    dead.port = "6390";
    client = createRedisClient(dead.toString(), log);

    await once(client, "error");
    client.disconnect();

    expect(lines().join("")).toContain("redis error");
    expect(lines().join("")).toContain("ECONNREFUSED");
  });
});
