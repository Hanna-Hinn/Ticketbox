# 0006 — Reconcile repairs the mirror first, then rebuilds the counter

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-027

## Context

The live counter in Redis and the computed count in Postgres can disagree: after a `FLUSHDB`, after an eviction, after a process died between two writes (ADR 0004's table). TB-027's Scope line is "recomputing availability from Postgres and overwriting Redis". Taken literally — `HSET tier remaining (total − sold − SUM(active rows))` — it is wrong for good after a `FLUSHDB`: every in-flight hold's row stays `active`, nothing ever changes it (the holds are gone, the sweeper's index is gone), and the counter is short by their sum forever. And in the other direction, a hold alive in Redis with no row (the save failed and the compensating release failed too) is held tickets Postgres knows nothing about; a counter rebuilt without it is too high, and when the sweeper later restores it the counter stays too high.

## Decision

Reconcile first makes the mirror agree with what the store still holds, then recomputes from Postgres — uncached — and overwrites the counter. Per tier: an active row whose hold is gone from the store, **entry and hash both**, is marked `expired`; a hold the store still indexes and the rows do not know is reported and its quantity subtracted from the counter's target — read from the index, never re-recorded. Then the counter is overwritten in one `MULTI` that answers what it replaced, and the report says both numbers.

## Alternatives considered

| Option                                                                    | Why not                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recompute from the rows as found (the Scope line, literally)              | Wrong for good after a `FLUSHDB` (above). The Acceptance line — one call restores correct availability — is unreachable.                                                                                                                                                                                           |
| Expire every active row whose token is not in the index                   | The first implementation, and a proven oversell: the index key can be evicted on its own, and a reserve plus its save can land between the index read and the row read. Such a hold is alive and can still convert; its row must stay. Only a hold gone from both keys is gone.                                    |
| Write a row for every indexed hold the rows do not know (`find` → `save`) | Bought nothing for the counter and was where every hard failure lived: a primary-key tie with `CreateHold`'s own save, a 500 on every later call for a row left in a non-active status. ADR 0004 asked for the index to be _read_. A later release or sweep adds the quantity back through the scripts either way. |
| Rebuild the index from Postgres as well                                   | After a `FLUSHDB` the rows that pointed at it belong to holds that are gone; expiring them is the right outcome. An index rebuilt from rows would resurrect holds nobody can release.                                                                                                                              |
| Read the cached repository                                                | A five-minute-old computed count written over the live counter is reconciliation in reverse. The composition root hands the use case the raw Postgres adapter.                                                                                                                                                     |
| A Lua script for the overwrite                                            | Nothing is decided between the read and the write; `MULTI`/`EXEC` is the non-Lua way to make two commands one unit, and the first use of it here.                                                                                                                                                                  |

## Consequences

## **Good:**

- The `FLUSHDB` rehearsal works: three holds, a flush, one call — `rowsExpired: 3`, `before: null`, `after: 1000`, and the next `POST /holds` decrements from 1000.
- Each combination of entry × hash × row has a stated outcome, and five of them are tested through the composed system.
- The mirror's first read path, `activeTokens`, is off the hot path (ADR 0004's revisit line fired, as it said it might).

## **Bad / accepted trade-off:**

- Reconcile is not atomic with the write path. A reserve between the Postgres read and the `HSET` is overwritten (counter too high by its quantity); a release or sweep in the same window is overwritten the other way (too low). An operator's tool, run when quiet; TB-031's lock is where a stronger guarantee would come from.
- One combination stays invisible: an entry gone, hash alive, no row — counted by nothing, too high until the hash dies. Bounded by the TTL.
- **A constraint for TB-029:** an index entry left behind a non-active row (a hold marked `converted` whose entry survives) would be `unrecorded` on every call and subtracted from a counter that already excludes it as sold. Consuming the hash and removing the entry must be one step.

## **What would make us revisit this:**

- TB-029 choosing to insert the row for a converting hold that has none — then reconcile's "never re-record" could be reconsidered with a reason.
- TB-031's lock making a reserve-free window cheap — then the overwrite could run inside it.
- The per-tier `find` in step (c) becoming measurable (one round trip per drifted row, only when a row has no entry).
