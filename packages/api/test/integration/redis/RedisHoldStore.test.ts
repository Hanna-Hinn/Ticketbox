import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hold } from "../../../src/domain/entities/Hold.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { RedisHoldStore } from "../../../src/infrastructure/redis/RedisHoldStore.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { CREATE_HOLD_LUA, SWEEP_HOLD_LUA } from "../../../src/infrastructure/redis/scripts.js";
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
      eventId: hold.eventId,
      qty: "2",
      createdAt: String(hold.createdAt.getTime()),
      expiresAt: String(hold.expiresAt.getTime()),
    });
    // The member carries the quantity: the hash will not outlive the hold,
    // the index must (TB-026).
    expect(await redis.zscore(keys.tierHolds(TIER), `${hold.token}:2`)).toBe(
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
    expect(found?.eventId).toBe(written.eventId);
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

  it("treats a hold hash from before the eventId field as a bug, not as a missing hold", async () => {
    // TB-022's script wrote four fields. A key with those four is a store
    // that was never flushed across the upgrade — a 500 that says so, never
    // a 404 that quietly tells the holder their tickets are gone.
    const createdAt = new Date(CREATED).getTime();
    await redis.hset(keys.hold(holdToken("tok-old")), {
      tierId: TIER,
      qty: 2,
      createdAt,
      expiresAt: createdAt + TTL_MS,
    });

    await expect(store.find(holdToken("tok-old"))).rejects.toThrow(/eventId/);
  });
});

// A hold whose score is in the past and whose hash is gone — what the sweeper
// finds. Written through the real script with a tiny TTL, then polled gone.
async function expiredHold(qty: number, token: string, tier = TIER): Promise<void> {
  await store.reserve(
    aHold().forTier(tier).withToken(token).withQty(qty).createdAt(CREATED).withTtl(50).build(),
  );
  const key = keys.hold(holdToken(token));
  const deadline = Date.now() + 2_000;
  while ((await redis.exists(key)) === 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("RedisHoldStore.expired", () => {
  it("lists every hold at or before now, across tiers, with its own tier and quantity, and none after", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await redis.hset(keys.tier(OTHER), "remaining", 10);
    const now = new Date(CREATED).getTime() + TTL_MS;
    await store.reserve(held(2, "tok-exact")); // expires exactly at now
    await store.reserve(
      aHold().forTier(OTHER).withToken("tok-other").withQty(3).createdAt(CREATED).build(),
    );
    await store.reserve(held(1, "tok-alive", TTL_MS + 1)); // one ms later

    const listed = await store.expired(new Date(now));

    expect(listed.map((hold) => [hold.token, hold.tierId, hold.qty]).sort()).toEqual([
      ["tok-exact", TIER, 2],
      ["tok-other", OTHER, 3],
    ]);
  });

  it("still lists a hold whose hash has expired — the index is what outlives the hold", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await expiredHold(2, "tok-gone");

    const listed = await store.expired(new Date());

    expect(await redis.exists(keys.hold(holdToken("tok-gone")))).toBe(0);
    expect(listed).toEqual([{ token: holdToken("tok-gone"), tierId: TIER, qty: 2 }]);
  });

  it("removes an entry it cannot read, warns once, and does not list it", async () => {
    // A bare token from before the member carried qty, and a member that
    // decodes but does not re-encode to itself: neither can be swept, and
    // an entry listed and refused every tick is a silent loop.
    const past = new Date(CREATED).getTime();
    await redis.zadd(keys.tierHolds(TIER), String(past), "tok-old", String(past), "tok-odd:02");

    const listed = await store.expired(new Date());

    expect(listed).toEqual([]);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((line) => line.includes("unreadable index entry"))).toBe(true);
  });

  it("skips, and warns about, an index key the registry cannot parse", async () => {
    // The scan's pattern and the parser have to agree; if they drift, a
    // sweeper that finds nothing must not be silent.
    await redis.zadd("ticketbox:v1:tier:a:b:holds", 1, "tok-x:1");

    const listed = await store.expired(new Date());

    expect(listed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("does not parse");
  });

  it("fails fast on a client that is not connected", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    await expect(offline.expired(new Date())).rejects.toThrow(/cannot list expired holds/);
    disconnected.disconnect();
  });
});

describe("RedisHoldStore.sweep (sweep_hold.lua)", () => {
  it("restores the exact quantity, removes the index entry and the hash, and answers the new count", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await expiredHold(2, "tok-gone"); // 10 → 8, and the hash is gone

    const result = await store.sweep(
      { token: holdToken("tok-gone"), tierId: TIER, qty: 2 },
      new Date(),
    );

    expect(result).toEqual({ swept: true, restored: true, remaining: 10 });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
    expect(await redis.exists(keys.hold(holdToken("tok-gone")))).toBe(0);
  });

  it("sweeping twice restores once", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await expiredHold(2, "tok-gone");
    const entry = { token: holdToken("tok-gone"), tierId: TIER, qty: 2 };

    const first = await store.sweep(entry, new Date());
    const second = await store.sweep(entry, new Date());

    expect(first).toEqual({ swept: true, restored: true, remaining: 10 });
    expect(second).toEqual({ swept: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
  });

  it("sweeps a hold whose hash still lingers, taking the hash with it", async () => {
    // TTL lag: the score is past, the key not yet reclaimed. The sweep does
    // not depend on the hash being gone.
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    const atExpiry = new Date(hold.expiresAt.getTime());

    const result = await store.sweep({ token: hold.token, tierId: TIER, qty: 2 }, atExpiry);

    expect(result).toEqual({ swept: true, restored: true, remaining: 10 });
    expect(await redis.exists(keys.hold(hold.token))).toBe(0);
  });

  it("refuses a hold that is not expired yet, warns, and writes nothing", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    const oneMsEarly = new Date(hold.expiresAt.getTime() - 1);

    const result = await store.sweep({ token: hold.token, tierId: TIER, qty: 2 }, oneMsEarly);

    expect(result).toEqual({ swept: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not expired");
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("8");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
    expect(await redis.exists(keys.hold(hold.token))).toBe(1);
  });

  it("answers swept but not restored when the tier has no counter: entry removed, no counter invented, warn", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await expiredHold(2, "tok-gone");
    await redis.del(keys.tier(TIER));

    const result = await store.sweep(
      { token: holdToken("tok-gone"), tierId: TIER, qty: 2 },
      new Date(),
    );

    expect(result).toEqual({ swept: true, restored: false });
    expect(await redis.exists(keys.tier(TIER))).toBe(0);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("without restoring");
  });

  it("throws on a counter that is not an integer, and has touched nothing", async () => {
    // The restore runs before the removes: an entry removed first would be
    // the sweeper's only trace of the tickets, gone with the error.
    await redis.hset(keys.tier(TIER), "remaining", 8);
    await expiredHold(2, "tok-gone");
    await redis.hset(keys.tier(TIER), "remaining", "eight");

    await expect(
      store.sweep({ token: holdToken("tok-gone"), tierId: TIER, qty: 2 }, new Date()),
    ).rejects.toThrow(/not an integer/);

    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("eight");
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(1);
  });

  it("finds nothing to sweep after a release took the same hold", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    const atExpiry = new Date(hold.expiresAt.getTime());

    const released = await store.release(hold.token);
    const swept = await store.sweep({ token: hold.token, tierId: TIER, qty: 2 }, atExpiry);

    expect(released).toEqual({ released: true, tierId: TIER, remaining: 10 });
    expect(swept).toEqual({ swept: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
  });

  it("leaves nothing to release after a sweep took the same hold", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);
    const atExpiry = new Date(hold.expiresAt.getTime());

    const swept = await store.sweep({ token: hold.token, tierId: TIER, qty: 2 }, atExpiry);
    const released = await store.release(hold.token);

    expect(swept).toEqual({ swept: true, restored: true, remaining: 10 });
    expect(released).toEqual({ released: false });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
  });

  it("is cached on the server after the first call (EVALSHA from then on)", async () => {
    await redis.script("FLUSH");
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await expiredHold(2, "tok-gone");
    const sha = createHash("sha1").update(SWEEP_HOLD_LUA).digest("hex");

    await store.sweep({ token: holdToken("tok-gone"), tierId: TIER, qty: 2 }, new Date());

    expect(await redis.script("EXISTS", sha)).toEqual([1]);
  });
});

describe("RedisHoldStore as InventoryRepair (held, rebuild)", () => {
  it("lists every entry of the tier with its quantity, expired-but-unswept included, and no other tier's", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    await redis.hset(keys.tier(OTHER), "remaining", 10);
    await store.reserve(held(2, "tok-alive"));
    await expiredHold(3, "tok-gone");
    await store.reserve(
      aHold().forTier(OTHER).withToken("tok-other").withQty(1).createdAt(CREATED).build(),
    );

    const listed = await store.held(TIER);

    expect(listed.map((entry) => [entry.token, entry.qty]).sort()).toEqual([
      ["tok-alive", 2],
      ["tok-gone", 3],
    ]);
  });

  it("skips an entry it cannot read without removing it — that is the sweeper's job", async () => {
    await redis.zadd(keys.tierHolds(TIER), "1", "tok-old", "2", "tok-ok:2");

    const listed = await store.held(TIER);

    expect(listed).toEqual([{ token: holdToken("tok-ok"), qty: 2 }]);
    expect(await redis.zcard(keys.tierHolds(TIER))).toBe(2);
  });

  it("overwrites the counter and answers the value it replaced", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 500);

    const result = await store.rebuild(TIER, 1000);

    expect(result).toEqual({ before: 500 });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("1000");
  });

  it("answers before: null for a counter that did not exist, and creates it", async () => {
    const result = await store.rebuild(TIER, 1000);

    expect(result).toEqual({ before: null });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("1000");
  });

  it("reports a hand-edited non-integer counter as absent, and still overwrites it", async () => {
    await redis.hset(keys.tier(TIER), "remaining", "3.5");

    const result = await store.rebuild(TIER, 7);

    expect(result).toEqual({ before: null });
    expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("7");
  });

  it("writes a counter the script then decrements from", async () => {
    await store.rebuild(TIER, 5);

    const reserved = await store.reserve(held(2));

    expect(reserved).toEqual({ ok: true, remaining: 3 });
  });

  it("throws when the counter key is the wrong type, and writes nothing", async () => {
    // Both replies of the transaction are read: a transaction is isolated,
    // not rolled back, and a failing HGET is also a failing HSET here.
    await redis.set(keys.tier(TIER), "not a hash");

    await expect(store.rebuild(TIER, 1000)).rejects.toThrow(/WRONGTYPE/);

    expect(await redis.get(keys.tier(TIER))).toBe("not a hash");
  });

  it("fails fast on a client that is not connected", async () => {
    const disconnected = new Redis(testRedisUrl(), { lazyConnect: true });
    const offline = new RedisHoldStore(disconnected, pino({ level: "silent" }));

    await expect(offline.held(TIER)).rejects.toThrow(/cannot list held/);
    await expect(offline.rebuild(TIER, 1)).rejects.toThrow(/cannot rebuild/);
    disconnected.disconnect();
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

  it("removes the composite index entry, not a bare token", async () => {
    await redis.hset(keys.tier(TIER), "remaining", 10);
    const hold = held(2);
    await store.reserve(hold);

    await store.release(hold.token);

    expect(await redis.zrange(keys.tierHolds(TIER), "0", "-1")).toEqual([]);
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
    const realTier = await redis.releaseHold(
      keys.hold(holdToken("tok-1")),
      keys.tier(TIER),
      keys.tierHolds(TIER),
      "tok-1",
      TIER,
    );

    expect(gone).toBe(-1);
    expect(wrongTier).toBe(-1);
    expect(realTier).toBe(8 + 2);
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
