import { once } from "node:events";
import type { Redis } from "ioredis";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeRedisClient, createRedisClient } from "../../../src/infrastructure/redis/client.js";
import { connectToTestRedis, testRedisUrl } from "../support/redis.js";

// A logger whose output the test can read: the lifecycle lines are the
// deliverable, not a side effect. Note on node:events' once(): it rejects if
// an "error" event fires first, so awaiting "ready" or "reconnecting" on a
// dead port would throw — await "error" there.
function capturingLogger(): { log: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const log = pino({ level: "info" }, { write: (chunk: string) => void lines.push(chunk) });
  return { log, lines };
}

// A closed port on the same host; a filtered one would hit ioredis's 10 s
// connectTimeout instead and the test would time out.
function deadPortUrl(): string {
  const url = new URL(testRedisUrl());
  url.port = "6390";
  return url.toString();
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
    await closeRedisClient(client);
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
    await admin.set("left-over", "from an earlier test");
    client = createRedisClient(testRedisUrl(), pino({ level: "silent" }));

    await admin.flushdb();

    expect(await client.get("left-over")).toBeNull();
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
    expect(lines.filter((line) => line.includes("redis reconnecting"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("redis ready"))).toHaveLength(2);
  });

  it("logs a connection error with its reason, and never a command's arguments", async () => {
    const { log, lines } = capturingLogger();
    client = createRedisClient(deadPortUrl(), log);

    await once(client, "error");

    // On a host where localhost has two address families the error is an
    // AggregateError with an empty message; the reason must still be logged.
    const errorLine = lines.find((line) => line.includes("redis error"));
    expect(errorLine).toContain("ECONNREFUSED");
    expect(errorLine).not.toContain('"command"');
  });

  it("closes at once while Redis is unreachable, even with a command queued", async () => {
    client = createRedisClient(deadPortUrl(), pino({ level: "silent" }));
    void client.ping().catch(() => undefined);
    await once(client, "error");

    const started = Date.now();
    await closeRedisClient(client);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
