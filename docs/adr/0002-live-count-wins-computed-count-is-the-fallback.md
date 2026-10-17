# 0002 — The live count wins; the computed count is the fallback

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-008 (revisited by TB-022, TB-027, TB-039)

## Context

Availability for a tier exists in two places. Postgres can _compute_ it — `total − sold − active mirror holds` (TB-010) — and Redis will _keep_ it as a live counter that `create_hold.lua` decrements atomically (TB-022). `GetEventAvailabilityUseCase` has to return one number per tier, and the two sources can disagree: before the counter has ever been seeded, after a `FLUSHDB`, after `allkeys-lru` evicts the key, or in the gap between a hold expiring in Redis and the sweeper marking the mirror row.

"Which source wins when the two disagree" is the central question of this repository — _Postgres remembers, Redis coordinates_ — so it needs a written answer rather than a `??` that happens to be there.

## Decision

The use case asks the `HoldStore` for the live count of every tier on the event and uses it where present. For a tier the store has no entry for, it uses the repository's computed count. In code: `live.get(tier.id) ?? tier.remaining`.

The live count is the authority for _what is happening now_ because it is the number `reserve` decides against; showing a different one would promise tickets the store will refuse. The computed count is the fallback because it is what the live count is rebuilt from (TB-027), so it is the best available answer when the store has none.

## Alternatives considered

| Option                                                      | Why not                                                                                                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Computed count only (ignore the store on reads)             | Reads and writes would disagree on every tier with an active hold: the page says 12, `reserve` says 10. The whole point of the live counter is that the number on screen is the number the write path uses.     |
| Live count only (a missing entry is `0` / an error)         | Before TB-022 there is no store; after a `FLUSHDB` every event would read as sold out until someone reconciles. Showing the computed number degrades to "slightly stale" instead of "closed".                   |
| Live count only, and the use case seeds the store on a miss | Puts a write on the read path, and makes the read path responsible for a counter the write path owns. Seeding is reconciliation's job (TB-027), done deliberately, not a side effect of someone opening a page. |
| Surface both numbers to the caller                          | Pushes the decision to the controller and the UI, which the handbook forbids ("the browser never computes availability").                                                                                       |

## Consequences

**Good:**

- The read path is already the fail-open half of TB-039: a store that _has no entry_ costs nothing but accuracy. (A store that _throws_ is a separate case TB-039 still has to handle.)
- One line, no new port, no configuration.

**Bad / accepted trade-off:**

- The use case cannot distinguish "never seeded" from "lost the key". After an eviction, reads show the computed count while `reserve` on the same tier answers whatever TB-022 decides for a missing key (TB-007 decision 11). Nothing logs the disagreement. This is the eviction failure mode TB-040 exists to observe, and this ADR is where it is admitted rather than hidden.
- The computed count can be stale in the other direction too: a hold that expired in Redis but whose mirror row the sweeper has not yet marked still counts as held in Postgres. The fallback under-reports until the sweeper runs, and over-reports by exactly the holds whose mirror write (TB-024) has not landed yet — a process that dies between `reserve` and `HoldRepository.save` leaves tickets held in Redis with no row in Postgres. TB-024's ADR owns that window.

**What would make us revisit this:**

- TB-022 deciding that `reserve` on a missing key should seed-and-proceed rather than refuse — then reads and writes would agree again and the fallback could become "missing key is a bug, log it". _TB-022 decided: refuse, and log a warn naming the tier on the write side, so the disagreement this ADR admitted is no longer silent; seeding stays reconciliation's (TB-027)._
- TB-039 wanting degraded reads to be _visible_ (a `degraded: true` flag in the response) rather than silent. That is a change to the output shape, not to this rule.
- Something other than reconciliation writing the counter. _TB-025 did: `pnpm seed` writes `tier:<id> remaining = total_qty` with `HSETNX` for dev and CI, so a seeded stack can take a hold without TB-027. It is a bootstrap of an empty system, not a rebuild — `HSETNX` writes nothing where a counter exists and `total_qty` where it does not, which is wrong over a used database. Reconciliation is still TB-027's._
- Any evidence that the computed query is too slow to run on every read (TB-013's benchmark) — then the fallback would need its own cache, and the "who seeds the counter" question moves to the read path after all.
