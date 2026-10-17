import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";

// Every Redis key in the system is built here, from a branded id, so a tier
// key can never be built from an event id and a string-literal key anywhere
// else is a review rejection (CLAUDE.md rule 9). Only the keys a merged task
// writes are defined; each later task adds its own. Single node, no
// cluster (handbook): no hash tags.

const KEY_PREFIX = "ticketbox:v1:";

export const keys = {
  // hash: { remaining } — the live counter (TB-022)
  tier: (id: TierId): string => `${KEY_PREFIX}tier:${id}`,
  // zset: token → expiresAt (epoch ms) — the sweeper's index (TB-022, TB-026)
  tierHolds: (id: TierId): string => `${KEY_PREFIX}tier:${id}:holds`,
  // hash: the live hold, with the TTL (TB-022)
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
