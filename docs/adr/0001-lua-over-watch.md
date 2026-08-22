# 0001 — Use a Lua script, not WATCH/MULTI, for atomic hold reservation

**Status:** Accepted
**Date:** _fill in when you actually make this decision in TB-022_
**Task:** TB-022

## Context

Reserving tickets for a hold requires: read current availability for a tier → decide whether the requested quantity fits → if it does, decrement availability and write the hold. Between the read and the write, another request can run the same sequence against the same tier. TB-021 (spike) demonstrated this directly: a naive `HGET` → check in TypeScript → `HINCRBY` implementation oversold a 10-ticket tier under 200 concurrent requests.

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

**Bad / accepted trade-off:**

- The script blocks the entire Redis server for its duration — acceptable here because the script is short and loop-free, but this is not free and would not scale to a script doing real work
- No rollback: if the script has a bug, it's a bug in production, not a transaction that can be aborted
- Debugging happens through `redis-cli` and logs, not a familiar language debugger — Lua is genuinely a second language in this codebase

**What would make us revisit this:**

- If the reservation logic grows beyond a few conditional branches, the "keep scripts short and loop-free" constraint would be violated and this decision should be reconsidered
- If we moved to Redis Cluster, multi-key scripts would need all keys to hash to the same slot — worth re-checking the key design at that point
