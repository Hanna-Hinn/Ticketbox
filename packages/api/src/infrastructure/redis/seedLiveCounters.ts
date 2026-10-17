import type { Redis } from "ioredis";
import { tierId } from "../../domain/value-objects/Ids.js";
import { keys } from "./keys.js";

export interface TierToSeed {
  readonly id: string;
  readonly totalQty: number;
}

// The dev and CI bootstrap for the live counter, not the production
// mechanism: HSETNX writes total_qty only where no counter exists, so a
// second run writes nothing — and so it is deliberately too dumb to repair a
// Redis that lost its counters while holds and orders exist. That is
// reconciliation's job (TB-027), which rebuilds from Postgres's computed
// count instead.
export async function seedLiveCounters(
  redis: Redis,
  tiers: readonly TierToSeed[],
): Promise<number> {
  let written = 0;
  for (const tier of tiers) {
    written += await redis.hsetnx(keys.tier(tierId(tier.id)), "remaining", tier.totalQty);
  }
  return written;
}
