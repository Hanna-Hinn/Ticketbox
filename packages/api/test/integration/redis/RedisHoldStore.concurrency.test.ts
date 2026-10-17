import type { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { RedisHoldStore } from "../../../src/infrastructure/redis/RedisHoldStore.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { aHold } from "../../fakes/builders.js";
import { connectToTestRedis } from "../support/redis.js";
import { ReleaseExpiredHoldsUseCase } from "../../../src/application/use-cases/ReleaseExpiredHolds.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";

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

// Two worker processes, or a tick overlapping the next: both list the same
// ten expired holds and both sweep them. The index entry is the receipt;
// the counter must land on exactly 1000, ten times in a row.
describe("two sweepers over the same 10 expired holds", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    "restore each hold exactly once, between them, and mark every row expired (run %i)",
    async () => {
      await redis.hset(keys.tier(TIER), "remaining", 1000);
      const createdAt = new Date("2026-01-01T10:00:00.000Z");
      const holds = Array.from({ length: 10 }, (_, i) =>
        aHold()
          .forTier(TIER)
          .withToken(`tok-${i}`)
          .withQty(1)
          .createdAt(createdAt)
          .withTtl(1)
          .build(),
      );
      const mirror = new InMemoryHoldRepository();
      for (const hold of holds) {
        await store.reserve(hold);
        await mirror.save(hold);
      }
      const otherClient = await connectToTestRedis();
      const otherStore = new RedisHoldStore(otherClient, pino({ level: "silent" }));
      const clock = { now: (): Date => new Date() };
      const sweepers = [
        new ReleaseExpiredHoldsUseCase(store, mirror, clock),
        new ReleaseExpiredHoldsUseCase(otherStore, mirror, clock),
      ];

      const results = await Promise.all(sweepers.map((sweeper) => sweeper.execute()));

      expect(results.reduce((sum, result) => sum + result.restored, 0)).toBe(10);
      expect(results.every((result) => result.unmarked.length === 0)).toBe(true);
      expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("1000");
      expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
      expect(holds.every((hold) => mirror.statusOf(hold.token) === "expired")).toBe(true);
      await otherClient.quit();
    },
  );
});

describe("50 concurrent confirms of the same hold", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    "sell it exactly once, and never give it back (run %i)",
    async () => {
      await redis.hset(keys.tier(TIER), "remaining", 10);
      const hold = aHold().forTier(TIER).withToken("tok-1").withQty(4).build();
      await store.reserve(hold);

      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.consume(hold.token)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await redis.hget(keys.tier(TIER), "remaining")).toBe("6");
      expect(await redis.exists(keys.hold(hold.token))).toBe(0);
      expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
    },
  );
});

// At the expiry instant the confirm and the sweeper want the same hold.
// Whoever runs first wins; the counter ends at 10 (the sweep won, tickets
// back) or 6 (the confirm won, tickets sold) — never 14. The adapter's
// consume reads the tier first, so on one connection the sweep would always
// get there first; the scripts are issued directly, in both orders, so each
// winner is seen and the loser's answer is checked against it.
describe("a confirm and the sweeper at the same hold, at its expiry", () => {
  it.each([
    ["the confirm", "6"],
    ["the sweep", "10"],
  ] as const)(
    "when %s runs first it wins, and the counter never gains twice",
    async (first, remaining) => {
      await redis.hset(keys.tier(TIER), "remaining", 10);
      const hold = aHold().forTier(TIER).withToken("tok-1").withQty(4).build();
      await store.reserve(hold);
      const atExpiry = new Date(hold.expiresAt.getTime());
      const consume = (): Promise<number> =>
        redis.consumeHold(keys.hold(hold.token), keys.tierHolds(TIER), hold.token, TIER);
      const sweep = (): Promise<number> =>
        redis.sweepHold(
          keys.tierHolds(TIER),
          keys.tier(TIER),
          keys.hold(hold.token),
          `${hold.token}:4`,
          4,
          atExpiry.getTime(),
        );

      const replies =
        first === "the confirm"
          ? await Promise.all([consume(), sweep()])
          : await Promise.all([sweep(), consume()]);

      // The winner's reply is positive (1 for consume, the new count for sweep); the loser's is -1.
      expect(replies.filter((reply) => reply >= 0)).toHaveLength(1);
      expect(replies[0]).toBeGreaterThanOrEqual(0);
      expect(await redis.hget(keys.tier(TIER), "remaining")).toBe(remaining);
      expect(await redis.exists(keys.hold(hold.token))).toBe(0);
      expect(await redis.zcard(keys.tierHolds(TIER))).toBe(0);
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
