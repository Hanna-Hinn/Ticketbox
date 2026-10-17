# 0004 — The Postgres hold row is a mirror, not the truth

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-024

## Context

A hold now exists in two places. Redis holds the live one: the counter the reserve script decides against, the hash with the hold's TTL, the sorted set the sweeper will read (TB-022, TB-023). Postgres holds a row in `holds` with a status (`active | converted | expired | released`), written by `CreateHoldUseCase` after the reserve and marked by `ReleaseHoldUseCase` after the release. Two stores for one concept means they will disagree — not if, when — and every reader needs to know which one to believe and what the disagreement costs.

## Decision

**Redis is the truth about what is held right now; the row is the record of what Redis decided.** The row is written after the store has decided and marked after the store has acted, never before, and nothing on the hot path reads it. When the two disagree, the live store wins for every decision (reserve, release, "is this hold alive"), and the row is what reconciliation (TB-027) uses to rebuild the store, which is why it must lag the truth rather than lead it.

## Alternatives considered

| Option                                                               | Why not                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres as the truth: a row with `expires_at`, the counter a column | Correct and simple — and the project exists to learn why the hot path is in Redis (ADR 0001): the decision under contention is one atomic script, and the TTL is a primitive. A row as the truth would need a row lock per reserve and a poller for expiry. |
| Write the row first, then reserve                                    | Records holds the store then refuses; every computed count would under-report until someone deletes the row. The row would lead a decision that has not been made.                                                                                          |
| One transaction across both (two-phase, or an outbox from Postgres)  | There is no transaction across Redis and Postgres. An outbox (TB-033) is the right shape for _publishing_ what Redis decided, not for deciding it; it would still write the row after.                                                                      |
| Compensate: release the Redis hold when the row write fails          | A second write, in the same request, to undo the first — and it can fail too. The window it closes (a hold with no row) is already bounded by the TTL and restored by the sweeper. More mechanism for the same bound.                                       |
| No mirror at all; rebuild from Redis's own index                     | Then an eviction, a `FLUSHDB` or a lost key loses the record for good, and nothing can say which holds existed or which converted to orders (TB-029). Redis coordinates; Postgres remembers.                                                                |

## Consequences

**Good:**

- Every decision has one authority. `reserve` and `release` never consult the row; `GetHold` never does either.
- The row's `active` sum is what the computed count subtracts (TB-010), so the fallback number moves with holds and releases, and reconcile has something to rebuild from.
- A row only ever leaves `active` once (`WHERE status = 'active'`): the audit trail keeps the first outcome; sweeper and release cannot rewrite each other.

**Bad / accepted trade-off:** the two disagree in exactly these windows, and here is what each costs:

| The disagreement                                      | How it happens                                                           | What it costs                                                                                                                                                       | Who closes it                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A hold in Redis, no row                               | The process dies, or Postgres is down, between `reserve` and `save`      | The caller gets an error and no token; the tickets stay held for ≤ 120 s; the computed count does not see them (over-reports by qty until then)                     | The TTL, then the sweeper (TB-026), whose script must tolerate "no row to mark" |
| Tickets back in Redis, row still `active`             | The process dies, or Postgres is down, between `release` and `setStatus` | The computed count under-reports by qty; the live count is right. A `FLUSHDB` + reconcile would re-subtract it — the one case where the row makes reconcile _wrong_ | Reconcile (TB-027) must expire rows whose hold is gone                          |
| Hold expired in Redis, row still `active`             | Normal: the TTL fires between sweeps                                     | Under-reports by qty until the sweep (ADR 0002 already accepts this)                                                                                                | The sweeper                                                                     |
| Hold evicted from Redis (`allkeys-lru`), row `active` | Memory pressure                                                          | As expired, but the sweeper's index entry may be gone too                                                                                                           | Reconcile; TB-040 observes it                                                   |

None of these can over-sell: the live counter is what `reserve` decides against, and the row is never read on that path. All of them can under-report, which is the direction this project chooses every time.

**What would make us revisit this:**

- TB-029 needing `orders` + `order_items` + the hold's `converted` in one transaction (TB-007 decision 10): the row is then written inside a Postgres transaction the order owns, and this ADR's "after Redis" rule applies to the whole transaction.
- TB-027 finding that reconcile needs the row to be _more_ than a mirror — e.g. an `expires_at` check of its own — then the row grows a read path and this ADR's "nothing reads it on the hot path" needs a line about which reads.
- A real write path to events (an edit, a cancellation) that must invalidate holds: that would be the first time Postgres led and Redis followed.
