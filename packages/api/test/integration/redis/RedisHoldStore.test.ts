import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hold } from "../../../src/domain/entities/Hold.js";
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

function held(qty: number, token = "tok-1", ttlMs = TTL_MS): Hold {
  return aHold()
    .forTier(TIER)
    .withToken(token)
    .withQty(qty)
    .createdAt(CREATED)
    .withTtl(ttlMs)
    .build();
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
    const hold = held(2);

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

    await store.reserve(held(2));

    const pttl = await redis.pttl(keys.hold(holdToken("tok-1")));
    expect(pttl).toBeGreaterThan(TTL_MS - 100);
    expect(pttl).toBeLessThanOrEqual(TTL_MS);
  });

  it("refuses when insufficient and writes nothing at all", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 1);

    const result = await store.reserve(held(2));

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("1");
    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
  });

  it("allows exactly the remainder, leaving zero, then refuses", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 2);

    const last = await store.reserve(held(2));
    const oneMore = await store.reserve(held(1, "tok-2"));

    expect(last).toEqual({ ok: true, remaining: 0 });
    expect(oneMore).toEqual({ ok: false, reason: "insufficient" });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("0");
  });

  it("refuses a tier with no counter, warns naming it, and writes nothing", async () => {
    const result = await store.reserve(held(1));

    expect(result).toEqual({ ok: false, reason: "insufficient" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no live counter");
    expect(warnings[0]).toContain(TIER);
    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
    expect(await redis.exists(keys.tier(TIER))).toBe(0);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
  });

  it("pays once for a token sent twice (the transport's resend after a reconnect)", async () => {
    // ioredis re-sends a command that was in flight when the socket dropped;
    // a script whose reply was lost runs again with the same arguments. The
    // hold key is the receipt.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);

    const first = await store.reserve(hold);
    const replay = await store.reserve(hold);

    expect(first).toEqual({ ok: true, remaining: 8 });
    expect(replay).toEqual({ ok: true, remaining: 8 });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("refuses a replay whose counter has gone missing, instead of answering nothing", async () => {
    // The receipt exists, the counter does not (evicted between the two
    // runs): the replay gets the same refusal a first run would, and the
    // warn, not a nil that the adapter would type as a number.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.del(keys.tier(TIER));

    const replay = await store.reserve(hold);

    expect(replay).toEqual({ ok: false, reason: "insufficient" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no live counter");
    expect(await redis.exists(keys.tier(TIER))).toBe(0);
  });

  it("refuses a replay whose counter is no longer a number", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.hset(keys.tier(TIER), "remaining", "ten");

    const replay = await store.reserve(hold);

    expect(replay).toEqual({ ok: false, reason: "insufficient" });
    expect(warnings).toHaveLength(1);
  });

  it("fails rather than guessing when the counter is not a number", async () => {
    await redis.hset(keys.tier(TIER), "remaining", "ten");

    await expect(store.reserve(held(1))).rejects.toThrow();

    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
  });

  it("is cached on the server after the first call (EVALSHA from then on)", async () => {
    // SCRIPT FLUSH is server-wide: every other client's next call goes back
    // to EVAL, which is the NOSCRIPT path ioredis handles. Without it this
    // test would pass on a warm server whether or not the script ever ran.
    await redis.script("FLUSH");
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const sha = createHash("sha1").update(CREATE_HOLD_LUA).digest("hex");

    await store.reserve(held(1));

    expect(await redis.script("EXISTS", sha)).toEqual([1]);
  });

  it("gives up on a connected client that does not answer, within the deadline", async () => {
    // The one real wait in this file: a client whose script call never
    // settles must be abandoned by the deadline, not by the OS.
    const silent = await connectToTestRedis();
    const stuck = new RedisHoldStore(silent, pino({ level: "silent" }));
    // defineCommand puts createHold on the instance as an own property
    // (Commander.js), so a plain assignment shadows it; no spy needed.
    silent.createHold = () => new Promise<number>(() => undefined);
    const started = Date.now();

    await expect(stuck.reserve(held(1))).rejects.toThrow(/reserve exceeded 1000ms/);

    expect(Date.now() - started).toBeLessThan(1_500);
    silent.disconnect();
  });

  it("fails fast on a client that is not connected instead of queueing the write", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    await expect(offline.reserve(held(1))).rejects.toThrow(/redis is wait; cannot reserve/);

    disconnected.disconnect();
  });
});

describe("RedisHoldStore.find", () => {
  it("rebuilds the hold it wrote, with the same instants", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const written = held(3);
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
    await store.reserve(held(2, "tok-short", 50));
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

  it("skips a counter that is not a number, warns, and keeps the rest", async () => {
    await redis.hset(keys.tier(TIER), "remaining", "ten");
    await redis.hset(keys.tier(OTHER), "remaining", 3);

    const live = await store.availability([TIER, OTHER]);

    expect(live).toEqual(new Map([[OTHER, 3]]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a number");
  });

  it("answers an empty map, not an error, while the client is not connected", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    expect(await offline.availability([TIER])).toEqual(new Map());

    disconnected.disconnect();
  });
});

describe("RedisHoldStore.release (release_hold.lua)", () => {
  it("restores the exact quantity, deletes the hold and drops it from the index", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);

    const result = await store.release(hold.token);

    expect(result).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
    expect(await redis.exists(keys.hold(hold.token))).toBe(0);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
  });

  it("releasing twice restores once", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);

    const first = await store.release(hold.token);
    const second = await store.release(hold.token);

    expect(first).toEqual(expect.objectContaining({ released: true, remaining: 10 }));
    expect(second).toEqual({ released: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
  });

  it("treats a token it has never seen as nothing to release, and writes nothing", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);

    const result = await store.release(holdToken("tok-nobody"));

    expect(result).toEqual({ released: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
  });

  it("does not restore an expired hold: that is the sweeper's, and its index entry stays for it", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await store.reserve(held(2, "tok-short", 50));
    const key = keys.hold(holdToken("tok-short"));
    const deadline = Date.now() + 2_000;
    while ((await redis.exists(key)) === 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const result = await store.release(holdToken("tok-short"));

    expect(result).toEqual({ released: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("refuses to release into a tier whose counter is gone, and warns", async () => {
    // HINCRBY would create a counter of size qty — a tier of 1000 reading as
    // 2 — and hide the tier from the computed-count fallback (ADR 0002).
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.del(keys.tier(TIER));

    const result = await store.release(hold.token);

    expect(result).toEqual({ released: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no live counter");
    expect(await redis.exists(keys.tier(TIER))).toBe(0);
    expect(await redis.exists(keys.hold(hold.token))).toBe(1);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("the script itself: a missing hold is -1, a tier mismatch is -1, and the real tier restores", async () => {
    // Every Lua script gets its own test. The adapter's prelude read
    // normally short-circuits a missing hold; the compare inside the script
    // is what holds when the hold vanishes between that read and the run.
    await redis.hset(keys.tier(TIER), "remaining", 10);

    const gone = await redis.releaseHold(
      keys.hold(holdToken("tok-gone")),
      keys.tier(TIER),
      keys.tierHolds(TIER),
      "tok-gone",
      TIER,
    );
    await store.reserve(held(2));
    const wrongTier = await redis.releaseHold(
      keys.hold(holdToken("tok-1")),
      keys.tier(OTHER),
      keys.tierHolds(OTHER),
      "tok-1",
      OTHER,
    );
    await redis.hset(keys.tier(OTHER), "remaining", 5);
    const noCounter = await redis.releaseHold(
      keys.hold(holdToken("tok-1")),
      keys.tier(TIER),
      keys.tierHolds(TIER),
      "tok-1",
      TIER,
    );

    expect(gone).toBe(-1);
    expect(wrongTier).toBe(-1);
    expect(noCounter).toBe(8 + 2);
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
    expect(await redis.hget(keys.tier(OTHER), "remaining")).toBe("5");
    expect(await redis.exists(keys.hold(holdToken("tok-1")))).toBe(0);
  });

  it("the script itself: a hold whose tier has no counter is -2 and touches nothing", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.del(keys.tier(TIER));

    const reply = await redis.releaseHold(
      keys.hold(hold.token),
      keys.tier(TIER),
      keys.tierHolds(TIER),
      hold.token,
      TIER,
    );

    expect(reply).toBe(-2);
    expect(await redis.exists(keys.hold(hold.token))).toBe(1);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("throws on a counter that is not an integer, and has touched nothing", async () => {
    // The restore runs before the deletes: a script's earlier writes are
    // not undone when a later command raises, so a hold deleted first would
    // have taken its tickets and the sweeper's trace of them with it.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.hset(keys.tier(TIER), "remaining", "abc");

    await expect(store.release(hold.token)).rejects.toThrow(/not an integer/);

    expect(await redis.exists(keys.hold(hold.token))).toBe(1);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("abc");
  });

  it("throws on a hold with no qty, and has touched nothing", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    await redis.hdel(keys.hold(hold.token), "qty");

    await expect(store.release(hold.token)).rejects.toThrow();

    expect(await redis.exists(keys.hold(hold.token))).toBe(1);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
  });

  it("maps the script's 'nothing to release' to released: false when the hold vanishes after the read", async () => {
    // The prelude read normally answers first; stubbing it is how the
    // adapter's -1 branch is reached deterministically.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const stubbed = await connectToTestRedis();
    const racing = new RedisHoldStore(stubbed, pino({ level: "silent" }));
    stubbed.hget = async () => TIER;

    const result = await racing.release(holdToken("tok-vanished"));

    expect(result).toEqual({ released: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
    stubbed.disconnect();
  });

  it("fails fast on a client that is not connected", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    await expect(offline.release(holdToken("tok-1"))).rejects.toThrow(/cannot release/);

    disconnected.disconnect();
  });

  it("gives up on a silent client at the deadline, on the read and on the script", async () => {
    // Two awaited commands, two deadlines; the ~1 s waits are the subject.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    // Stub after constructing: the constructor's defineCommand puts the
    // real releaseHold on the instance and would overwrite a stub set before.
    const silentRead = await connectToTestRedis();
    const readStuck = new RedisHoldStore(silentRead, pino({ level: "silent" }));
    silentRead.hget = () => new Promise<string | null>(() => undefined);
    const silentScript = await connectToTestRedis();
    const scriptStuck = new RedisHoldStore(silentScript, pino({ level: "silent" }));
    silentScript.releaseHold = () => new Promise<number>(() => undefined);

    await expect(readStuck.release(hold.token)).rejects.toThrow(/release exceeded 1000ms/);
    await expect(scriptStuck.release(hold.token)).rejects.toThrow(/release exceeded 1000ms/);

    silentRead.disconnect();
    silentScript.disconnect();
  });
});
