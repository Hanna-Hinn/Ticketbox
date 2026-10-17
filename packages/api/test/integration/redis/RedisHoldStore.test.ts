import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { RedisHoldStore } from "../../../src/infrastructure/redis/RedisHoldStore.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { CREATE_HOLD_LUA } from "../../../src/infrastructure/redis/scripts.js";
import { aHold } from "../../fakes/builders.js";
import { connectToTestRedis, testRedisUrl } from "../support/redis.js";

const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const OTHER = tierId("11111111-1111-4111-8111-bbbbbbbbbbbb");
const CREATED = "2026-01-01T10:00:00.000Z";
const TTL_MS = 120_000;

function held(qty: number, token = "tok-1", ttlMs = TTL_MS): ReturnType<typeof aHold>["build"] {
  return () =>
    aHold().forTier(TIER).withToken(token).withQty(qty).createdAt(CREATED).withTtl(ttlMs).build();
}

let redis: Redis;
let warnings: string[];
let store: RedisHoldStore;

beforeAll(async () => {
  redis = await connectToTestRedis();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
  warnings = [];
  const log = pino({ level: "warn" }, { write: (line: string) => void warnings.push(line) });
  store = new RedisHoldStore(redis, log);
});

describe("RedisHoldStore.reserve (create_hold.lua)", () => {
  it("decrements the counter and writes the hold and its index entry", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2)();

    const result = await store.reserve(hold);

    expect(result).toEqual({ ok: true, remaining: 8 });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
    expect(await redis.hgetall(keys.hold(hold.token))).toEqual({
      tierId: TIER,
      qty: "2",
      createdAt: String(hold.createdAt.getTime()),
      expiresAt: String(hold.expiresAt.getTime()),
    });
    expect(await redis.zscore(keys.tierHolds(TIER), hold.token)).toBe(
      String(hold.expiresAt.getTime()),
    );
  });

  it("gives the hold key the hold's TTL, within tolerance", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);

    await store.reserve(held(2)());

    const pttl = await redis.pttl(keys.hold(holdToken("tok-1")));
    expect(pttl).toBeGreaterThan(TTL_MS - 100);
    expect(pttl).toBeLessThanOrEqual(TTL_MS);
  });

  it("refuses when insufficient and writes nothing at all", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 1);

    const result = await store.reserve(held(2)());

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("1");
    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
  });

  it("allows exactly the remainder, leaving zero, then refuses", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 2);

    const last = await store.reserve(held(2)());
    const oneMore = await store.reserve(held(1, "tok-2")());

    expect(last).toEqual({ ok: true, remaining: 0 });
    expect(oneMore).toEqual({ ok: false, reason: "insufficient" });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("0");
  });

  it("refuses a tier with no counter, warns naming it, and writes nothing", async () => {
    const result = await store.reserve(held(1)());

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no live counter");
    expect(warnings[0]).toContain(TIER);
    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
    expect(await redis.exists(keys.tier(TIER))).toBe(0);
  });

  it("is cached on the server after the first call (EVALSHA from then on)", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const sha = createHash("sha1").update(CREATE_HOLD_LUA).digest("hex");

    await store.reserve(held(1)());

    expect(await redis.script("EXISTS", sha)).toEqual([1]);
  });

  it("fails fast on a client that is not connected instead of queueing the write", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    await expect(offline.reserve(held(1)())).rejects.toThrow(/redis is wait; cannot reserve/);

    disconnected.disconnect();
  });
});

describe("RedisHoldStore.find", () => {
  it("rebuilds the hold it wrote, with the same instants", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const written = held(3)();
    await store.reserve(written);

    const found = await store.find(written.token);

    expect(found?.token).toBe(written.token);
    expect(found?.tierId).toBe(TIER);
    expect(found?.qty.value).toBe(3);
    expect(found?.createdAt).toEqual(written.createdAt);
    expect(found?.expiresAt).toEqual(written.expiresAt);
  });

  it("answers null for a token it has never seen", async () => {
    expect(await store.find(holdToken("tok-nobody"))).toBeNull();
  });

  it("forgets the hold when its TTL elapses, and does not give its tickets back", async () => {
    // The one test allowed a real wait: a 50 ms TTL, polled, no fixed sleep.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await store.reserve(held(2, "tok-short", 50)());
    const key = keys.hold(holdToken("tok-short"));

    const deadline = Date.now() + 2_000;
    while ((await redis.exists(key)) === 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await store.find(holdToken("tok-short"))).toBeNull();
    // Expiry is not a release: the counter stays at 8 until the sweeper
    // (TB-026) finds the index entry whose key is gone.
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("treats a hold hash it did not write as a bug", async () => {
    await redis.hset(keys.hold(holdToken("tok-odd")), { tierId: TIER, qty: "two" });

    await expect(store.find(holdToken("tok-odd"))).rejects.toThrow(/createdAt/);
  });
});

describe("RedisHoldStore.availability", () => {
  it("returns the live count of every seeded tier and nothing for the rest", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 7);

    const live = await store.availability([TIER, OTHER]);

    expect(live).toEqual(new Map([[TIER, 7]]));
  });

  it("answers an empty map, not an error, while the client is not connected", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    expect(await offline.availability([TIER])).toEqual(new Map());

    disconnected.disconnect();
  });
});

describe("RedisHoldStore.release", () => {
  it("is not implemented until TB-023's compare-and-restore script", async () => {
    await expect(store.release()).rejects.toThrow(/TB-023/);
  });
});
