# 0003 — Cache-aside over write-through, and fail-open

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-018

## Context

`GET /events/:id` is the hottest read in the system and, after TB-013's index, costs two Postgres queries and ~23 ms. The delivery plan wants Redis in front of it, as a decorator on `EventRepository` that nothing above L3 can see. Two questions had to be settled before writing it: which caching pattern, and what a read does while Redis is gone — because TB-017 left ioredis's offline queue on, so a `GET` issued during a reconnect waits rather than fails.

## Decision

**Cache-aside** (read-through on a miss, `SET … EX 300`, explicit `DEL` on a write), implemented as `CachedEventRepository` wrapping `PgEventRepository`, wired in the composition root only. **Fail-open:** when the client is not `ready` the cache is skipped, and a cache command that throws is treated as a miss and logged. Cached bytes are untrusted and are parsed through a Zod schema; a rejected payload is a miss, never an error.

## Alternatives considered

| Option                                              | Why not                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write-through (update Redis on every write)         | There is no event write path — the seed inserts once and nothing updates. Write-through has nothing to hang off, and it couples the writer to the cache's shape. When a writer appears, `invalidate(id)` (a `DEL`) is the hook; TB-019a shows what forgetting it costs.                                                                                   |
| No cache at all                                     | The honest option on this data set: 23 ms is fine. Rejected because the project exists to learn the pattern and its failure modes (stale window, stampede, immortal keys), and TB-019 measures whether it buys anything against the _indexed_ baseline. If that row says no, this ADR says so here: it was built to learn, not because Postgres was slow. |
| Fail-closed (a Redis outage fails the read)         | Turns a cache outage into an outage. Worse: with the offline queue on it is not even a failure but a hang, up to 20 reconnect attempts. A cache that makes reads less available than no cache is wrong by definition.                                                                                                                                     |
| A per-command timeout instead of the `status` guard | Would also bound the wait, but every read would pay the timeout while Redis is down. `status !== "ready"` is known before issuing the command and costs nothing; the `try/catch` covers the socket dying mid-command.                                                                                                                                     |
| Trust the cached JSON (no schema)                   | A different version of this code, a hand edit in RedisInsight, or a spike can write that key. The domain constructors would throw on a bad payload and the read would be a 500 for a cache problem. The schema is strict enough that what it accepts cannot fail them.                                                                                    |
| Cache `listUpcoming` too                            | A query over time under one key serves events that have already started until the TTL runs out. Pass-through.                                                                                                                                                                                                                                             |

## Consequences

**Good:** the boundary held — no controller, use case or DTO changed. Reads survive a Redis outage unchanged. A corrupt entry heals itself on the next read.

**Bad / accepted trade-off:** up to 300 s of staleness after any change to an event (nothing changes events today). The first read of a cold key still pays Postgres, and under concurrency every concurrent miss does — the stampede TB-019 closes. Hit/miss are invisible until TB-019's counters.

**What would make us revisit this:** an event write path (then `invalidate` gets a caller, or write-through becomes worth its coupling); TB-019's benchmark showing the cache buys nothing measurable; a reason to cache the list (a `now`-bucketed key would be the shape).
