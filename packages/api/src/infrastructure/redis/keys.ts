import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import { tierId, type EventId, type TierId } from "../../domain/value-objects/Ids.js";

// Every Redis key in the system is built here, from a branded id, so a tier
// key can never be built from an event id and a string-literal key anywhere
// else is a review rejection (CLAUDE.md rule 9). Only the keys a merged task
// writes are defined; each later task adds its own. Single node, no
// cluster (handbook): no hash tags.

const KEY_PREFIX = "ticketbox:v1:";
const TIER_HOLDS_KEY = /^ticketbox:v1:tier:([^:]+):holds$/;

export const keys = {
  // hash: { remaining } — the live counter (TB-022)
  tier: (id: TierId): string => `${KEY_PREFIX}tier:${id}`,
  // zset: "<token>:<qty>" → expiresAt (epoch ms) — the sweeper's index
  // (TB-022, TB-026). The member carries qty (holdIndex.ts) because the
  // hold hash, and its qty, are gone by the time the entry may be swept.
  tierHolds: (id: TierId): string => `${KEY_PREFIX}tier:${id}:holds`,
  // The SCAN pattern for every tier's index, and the way back from a key
  // the scan returned to the tier it names (TB-026). Only this module knows
  // the layout well enough to parse it.
  tierHoldsPattern: (): string => `${KEY_PREFIX}tier:*:holds`,
  tierIdOfHolds: (key: string): TierId | null => {
    const match = TIER_HOLDS_KEY.exec(key);
    return match?.[1] === undefined ? null : tierId(match[1]);
  },
  // hash: { tierId, eventId, qty, createdAt, expiresAt } — the live hold, with the TTL (TB-022, TB-025)
  hold: (token: HoldToken): string => `${KEY_PREFIX}hold:${token}`,
  // string: the JSON of an Event, CACHE_TTL_SECONDS — the cache-aside entry (TB-018).
  // Its own namespace, so cache keys can be targeted without touching holds.
  eventCache: (id: EventId): string => `${KEY_PREFIX}cache:event:${id}`,
  // string: the single-flight mutex for one event's refresh, PX-bounded (TB-019)
  eventRefresh: (id: EventId): string => `${KEY_PREFIX}cache:event:${id}:refresh`,
  // integers, no TTL: INCR'd on every cache lookup (TB-019)
  cacheStats: {
    hits: `${KEY_PREFIX}cache:stats:hits`,
    misses: `${KEY_PREFIX}cache:stats:misses`,
  },
} as const;
