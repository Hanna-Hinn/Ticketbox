import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// Every Redis key in the system is built here, from a branded id, so a tier
// key can never be built from an event id and a string-literal key anywhere
// else is a review rejection (CLAUDE.md rule 9). Only the keys a merged task
// writes are defined; each later task adds its own.
//
// The braces around the tier id are Redis hash tags: both tier keys hash to
// the same slot, so a Lua script touching both stays valid under a cluster.
// Single node today. The hold key is not tagged — a script touching a hold
// and its tier would not be cluster-safe; TB-022 records that when the
// script exists.

export const KEY_PREFIX = "ticketbox:v1:";

export const keys = {
  // hash: { remaining } — the live counter (TB-022)
  tier: (id: TierId): string => `${KEY_PREFIX}tier:{${id}}`,
  // zset: token → expiresAt (epoch ms) — the sweeper's index (TB-022, TB-026)
  tierHolds: (id: TierId): string => `${KEY_PREFIX}tier:{${id}}:holds`,
  // hash: the live hold, with the TTL (TB-022)
  hold: (token: HoldToken): string => `${KEY_PREFIX}hold:${token}`,
} as const;
