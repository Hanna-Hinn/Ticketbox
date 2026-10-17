# 0005 — The index carries the quantity: sweeping after the TTL

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-026

## Context

A hold is a hash with the hold's own TTL (TB-022) and an entry in a per-tier sorted set scored by its expiry — the sweeper's index. When the TTL fires, Redis drops the hash and nothing gives the tickets back: `remaining` was decremented by `create_hold.lua` and stays decremented. TB-026's sweeper reads the index for entries whose score is past and restores each one's quantity. But at the first instant it is allowed to act, the hash — the only place `qty` had lived — is gone with its TTL. The sweeper cannot restore a quantity it cannot read, and the Scope line ("a Lua script that restores inventory") does not say where it comes from.

## Decision

The index entry carries the quantity: the sorted-set member is `"<token>:<qty>"`, the score stays `expiresAt`. `create_hold.lua` writes it, `release_hold.lua` and `sweep_hold.lua` remove the same member, and `sweep_hold.lua` restores the quantity the member names, with the entry itself as the once-only receipt. The hash keeps its TTL as the hold's life; the index is what outlives the hold, so the index carries what the sweeper needs.

## Alternatives considered

| Option                                                                 | Why not                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read `qty` from the Postgres row                                       | The sweeper's restore is a write-path inventory decision, and ADR 0004's rule is that no write-path decision reads the mirror. A hold with no row (ADR 0004 row 1) would be unrestorable forever, and a row that lags would restore the wrong number.                                                       |
| A grace TTL on the hash beyond `expiresAt`, read `qty` from it         | Two definitions of "expired" — the clock's and the key's — with the fake and the real store diverging on "cannot release an expired hold". Still a window: a sweeper down longer than the grace loses the quantity, and the sweeper exists for exactly the moments when something was down.                 |
| A second hash per tier, `tier:<id>:holdqty { token: qty }`             | One more key that must agree with the index, evicted independently, touched by three scripts. A composite member is one structure that cannot disagree with itself.                                                                                                                                         |
| One global `holds:expiry` zset instead of per-tier indexes (no `SCAN`) | The per-tier shape is TB-022's and `release_hold.lua` already addresses it by tier; a global index would need the tier in the member too. `SCAN` costs the sweeper a few round trips every five seconds and teaches `SCAN` versus `KEYS`. Revisit if the number of tiers ever makes the scan the slow part. |

## Consequences

## **Good:**

- The sweeper is self-sufficient on Redis: restoring Redis inventory never waits on Postgres, which is the coupling ADR 0004 refuses in the other direction.
- One receipt for everyone: a release and a sweep, or two sweeps, remove the same member, so whichever runs first pays and the other finds nothing. The concurrency test lands the counter on exactly 1000 ten runs in a row.
- Nothing new to evict: the index already had to survive the hold.

## **Bad / accepted trade-off:**

- A key's shape changed (Reference Impact Analysis in the plan). A hold in flight across the upgrade has a bare-token member the sweeper cannot decode; it removes it, warns, and leaves the quantity to reconciliation (TB-027). Nothing is deployed; dev and CI `FLUSHDB`.
- A member that decodes but does not re-encode to itself (`tok:02`) is treated the same way, because the script looks the re-encoded member up; otherwise it would be listed and refused every tick, silently. The decoder round-trips before it answers.
- If the index itself is evicted, those holds are never swept and their counters stay low until reconciliation rebuilds them — the eviction failure mode TB-040 exists to observe. The index was always load-bearing; this ADR makes it load-bearing for the quantity too.

## **What would make us revisit this:**

- TB-027 choosing to rebuild the index from Postgres as part of reconciliation — then the member could carry less, because the rows would be the recovery path for everything. _TB-027 did not: it trusts the index, expires the rows of holds gone from both keys, and subtracts what the index holds that the rows do not (ADR 0006)._
- Redis hash-field expiry (7.4+) making the hash itself the index: one structure per tier with per-field TTLs, and no composite members. Not available on the 7.0 this project runs.
- The scan becoming measurable (BENCHMARKS) — then a global index.
