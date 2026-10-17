# 0001 — Use a Lua script, not WATCH/MULTI, for atomic hold reservation

**Status:** Accepted
**Date:** 2026-10-17 (written as a placeholder in TB-001; dated and completed by TB-022)
**Task:** TB-022

## Context

Reserving tickets for a hold requires: read current availability for a tier → decide whether the requested quantity fits → if it does, decrement availability and write the hold. Between the read and the write, another request can run the same sequence against the same tier. TB-021 (spike) demonstrated this directly: a naive `HGET` → check in TypeScript → `HINCRBY` implementation answered **200 of 200** requests with a hold against a 10-ticket tier and left the counter at **−390** — 195 oversold holds — six runs out of six, on one connection and on ten (`docs/NOTES.md` § TB-021). The same test against `create_hold.lua`: exactly 5 holds, counter exactly 0, the five winners seeing 8, 6, 4, 2, 0 — twenty runs out of twenty (`BENCHMARKS.md` §7).

Redis offers two ways to make a read-decide-write sequence safe: optimistic locking with `WATCH`/`MULTI`/`EXEC`, or a Lua script.

## Decision

Use a Lua script (`create_hold.lua`), registered via `defineCommand` and executed with `EVALSHA`. The entire read-decide-write sequence happens inside the script, which Redis runs as a single atomic, blocking unit — no other client's commands can interleave with it while it runs.

## Alternatives considered

| Option                                                             | Why not                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WATCH tier:{id}` + `MULTI`/`EXEC`, retry loop in app code         | Works, but under real contention (a popular tier, many concurrent buyers) most attempts abort and retry, pushing complexity into the application and degrading badly exactly when correctness matters most — high demand |
| Plain `HGET` + `HINCRBY`, accept the race                          | Proven wrong in TB-021 — oversold the tier                                                                                                                                                                               |
| Move the whole decision into Postgres with `SELECT ... FOR UPDATE` | Correct, but re-introduces the connection-pool bottleneck this project uses Redis to avoid, and loses the self-expiring TTL that makes the hold's 120-second window free to implement                                    |

## Consequences

**Good:**

- One round trip, one atomic unit, no retry loop to get wrong
- Business logic ("insufficient inventory") and mechanism (the decrement) live in the same script, so there's no window where they can disagree
- TTL and inventory decrement happen together, so a hold's expiry and its reservation are set up atomically too
- The script is the right place to absorb the transport's own retry: ioredis re-sends a command that was in flight when the socket dropped, so a script whose reply was lost runs again with the same token. `EXISTS` on the hold key — the token's receipt — makes the replay answer with the current count instead of paying twice. A `WATCH` loop in app code would have had to carry that state itself
- One clock: the use case's `Clock` sets the hold's `expiresAt`, and the script writes that same instant into the hold hash and the sweeper's sorted set; only the key's `PEXPIRE` is relative, on Redis's clock. Under skew the key and the index can disagree by the skew, and TB-023/TB-026 must be correct in either order

**Bad / accepted trade-off:**

- The script blocks the entire Redis server for its duration — acceptable here because the script is short and loop-free, but this is not free and would not scale to a script doing real work
- No rollback: if the script has a bug, it's a bug in production, not a transaction that can be aborted
- Debugging happens through `redis-cli` and logs, not a familiar language debugger — Lua is genuinely a second language in this codebase

**What would make us revisit this:**

- If the reservation logic grows beyond a few conditional branches, the "keep scripts short and loop-free" constraint would be violated and this decision should be reconsidered
- If we moved to Redis Cluster, multi-key scripts would need all keys to hash to the same slot — worth re-checking the key design at that point
