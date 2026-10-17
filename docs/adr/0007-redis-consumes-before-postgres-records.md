# 0007 — Redis consumes before Postgres records

**Status:** Accepted
**Date:** 2026-10-17
**Task:** TB-029

## Context

Confirming an order is the one irreversible step: held tickets become sold ones. Two stores take part — the hold is consumed in Redis (its hash and its index entry removed, nothing restored) and the order, its items and the hold's row flipped to `converted` are written in one Postgres transaction — and no transaction spans both. One of the two writes has to come first, and the order of the two decides which failure the system can have.

## Decision

Redis first. `consume_hold.lua` is the decision — "is it still held, and now it is sold", in one script — and Postgres records after it. The repository's transaction begins with `UPDATE holds SET status = 'converted' WHERE token = $1 AND status = 'active'` and requires exactly one row; a hold with no active row (none at all, or one already expired or released) cannot be confirmed, and no row is inserted for it. The entity decides expiry before any of this, as `GetHold` does, so the checkout page and the confirm never disagree about a hold in the skew between the application's clock and Redis's.

## Alternatives considered

| Option                                                                  | Why not                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres first, then consume the hold                                   | The order commits, then Redis is unreachable: the hold stays alive and the sweeper restores its quantity at expiry on top of a sold ticket — **an oversell**, and exactly the entry-behind-a-converted-row ADR 0006 forbade.                                                                            |
| Postgres first with a compensating delete of the order on Redis failure | A second write to the engine that just failed, on the oversell side of the seam; and a retry of the confirm would find a hold Redis still has and sell it again.                                                                                                                                        |
| Redis first with a compensating restore on Postgres failure             | A bare `HINCRBY` with no receipt: a retry of the compensation restores twice. The failure it would fix is an under-sell that reconcile already repairs, and a retry of the confirm is a 410, not a second attempt — there is no amplification to compensate for (unlike TB-024's reserve/save).         |
| Insert the missing row for a hold the mirror never recorded             | What ADR 0006 declined for reconcile, for the same reason: an order whose hold Postgres never recorded is a history Postgres cannot explain. The hold is consumed by then; the tickets sit un-sellable until reconcile expires the row — the same under-sell as any Postgres failure after the consume. |
| Let the Redis TTL alone decide expiry at the confirm                    | `GetHold` asks the entity; a confirm that did not would succeed, in the clock skew, for a hold the checkout page had just called expired.                                                                                                                                                               |

## Consequences

## **Good:**

- The failure direction is always the safe one: a consume followed by a failed record leaves no order and a hold that is gone — tickets not on sale until reconcile expires the row, never two owners for one ticket.
- The three scripts that can want one hold at its expiry instant — confirm, sweep, release — each take a receipt and remove both keys; whichever runs first wins and the counter never gains twice (tested in both orders).
- The tickets never pass through "available": no `HINCRBY` anywhere on the confirm path, and the computed count moves the quantity from `holds` to `order_items` in one transaction (TB-010's disjoint sums).

## **Bad / accepted trade-off:**

- **A reused `Idempotency-Key` on a fresh hold burns the hold.** The consume succeeds, the constraint refuses the order, the hold is gone and its row stays `active`: the under-sell, triggered by a well-formed 4xx request rather than an outage, and the customer told 409 and nothing about the hold. TB-030's Redis layer answers the retry before any of this runs; until then this is the one path where a client can lose a hold with a valid request. Pinned by a route test so TB-030 has a red test to turn green.
- **A reconcile landing between the consume and the commit fails a valid confirm.** After the consume the hold is gone from both keys, which is reconcile's own test for "expire the row" (ADR 0006); the confirm's `UPDATE … AND status = 'active'` then touches no row, the transaction rolls back, the customer gets a 500 with both engines healthy, and reconcile's rebuild puts the quantity back on sale. One lost sale, never an oversell. The flip-first ordering makes the window one statement wide; ADR 0006's "run when quiet" is the operator's rule. Not widened to accept `expired`: that would rewrite the audit trail ADR 0004 protects. (Reconcile also counts that row as `rowsExpired` whether or not its UPDATE matched — an over-count by one in its report.)
- **An index entry evicted alone, then a confirm:** the consume takes the hash and the entry is already gone; harmless. **A hash evicted alone:** `find` is `null`, the customer gets 410 while the timer still runs, and the sweeper restores from the entry — the same thing GetHold already shows them.

## **What would make us revisit this:**

- TB-030 making the Redis idempotency layer the first thing `POST /orders` consults — the burned-hold window then closes without touching this order.
- TB-031's lock making a reconcile-free window cheap — the confirm could hold it for its three statements.
- Stage 8 moving the confirm into a background worker (TB-033): the order of the two writes stays, but the retry semantics become the stream's.
