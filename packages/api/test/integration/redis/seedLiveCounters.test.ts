import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { keys } from "../../../src/infrastructure/redis/keys.js";
import { seedLiveCounters } from "../../../src/infrastructure/redis/seedLiveCounters.js";
import { connectToTestRedis } from "../support/redis.js";

const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
const VIP = tierId("11111111-1111-4111-8111-cccccccccccc");
const tiers = [
  { id: GENERAL, totalQty: 1000 },
  { id: VIP, totalQty: 0 },
];

let redis: Redis;

beforeAll(async () => {
  redis = await connectToTestRedis();
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await redis.flushdb();
});

describe("seedLiveCounters", () => {
  it("writes total_qty as the live counter of every tier, including a sold-out one", async () => {
    const written = await seedLiveCounters(redis, tiers);

    expect(written).toBe(2);
    expect(await redis.hget(keys.tier(GENERAL), "remaining")).toBe("1000");
    expect(await redis.hget(keys.tier(VIP), "remaining")).toBe("0");
  });

  it("writes nothing on a second run, and never over a counter that is already there", async () => {
    await seedLiveCounters(redis, tiers);
    await redis.hset(keys.tier(GENERAL), "remaining", 7);

    const written = await seedLiveCounters(redis, tiers);

    expect(written).toBe(0);
    expect(await redis.hget(keys.tier(GENERAL), "remaining")).toBe("7");
  });
});
