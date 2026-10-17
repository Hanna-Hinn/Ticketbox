import type { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { RedisHoldStore } from "../../../src/infrastructure/redis/RedisHoldStore.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { aHold } from "../../fakes/builders.js";
import { connectToTestRedis } from "../support/redis.js";

// The TB-021 test, kept. The naive store answered 200 of 200 and left the
// counter at -390 (docs/NOTES.md); the script must answer exactly 5 and
// leave exactly 0, twenty times in a row. A concurrency test that passes
// once proves nothing.
const TIER = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");

let redis: Redis;
let store: RedisHoldStore;

beforeAll(async () => {
  redis = await connectToTestRedis();
  store = new RedisHoldStore(redis, pino({ level: "silent" }));
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

describe("200 concurrent reserves of 2 against a tier with 10 remaining", () => {
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    "sells exactly 10 tickets to exactly 5 callers and never goes negative (run %i)",
    async () => {
      await redis.hset(keys.tier(TIER), "remaining", 10);

      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          store.reserve(aHold().forTier(TIER).withToken(`tok-${i}`).withQty(2).build()),
        ),
      );

      const successes = results.filter((result) => result.ok);
      expect(successes).toHaveLength(5);
      // Each winner saw a distinct, non-negative count: 8, 6, 4, 2, 0.
      expect(
        successes.map((result) => (result.ok ? result.remaining : NaN)).sort((a, b) => a - b),
      ).toEqual([0, 2, 4, 6, 8]);
      expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("0");
      expect(await redis.zcard(keys.tierHolds(TIER))).toBe(5);
      // A glob through the registry: the only way it offers to build a
      // pattern; a keys.holdPattern() is TB-040's (KEYS vs SCAN).
      expect(await redis.keys(keys.hold(holdToken("*")))).toHaveLength(5);
    },
  );
});

// Also the only test that exercises the script's own compare through the
// adapter: every sequential release is answered by the adapter's prelude
// read before the script runs. Do not trim the runs.
describe("50 concurrent releases of the same hold", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    "gives the tickets back exactly once (run %i)",
    async () => {
      await redis.hset(keys.tier(TIER), "remaining", 10);
      const hold = aHold().forTier(TIER).withToken("tok-1").withQty(4).build();
      await store.reserve(hold);

      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.release(hold.token)),
      );

      expect(results.filter((result) => result.released)).toHaveLength(1);
      expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("10");
      expect(await redis.exists(keys.hold(hold.token))).toBe(0);
      expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
    },
  );
});
