# TB-029 — ConfirmOrder use case

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-029 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-029-confirm-order.md`](../implementation-plans/TB-029-confirm-order.md)
**Branch / PR:** `feat/TB-029-confirm-order` · [#34](https://github.com/Hanna-Hinn/Ticketbox/pull/34) (based on #33)
**ADR:** [`docs/adr/0007-redis-consumes-before-postgres-records.md`](../adr/0007-redis-consumes-before-postgres-records.md)

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

You can buy a ticket. `POST /orders` with a hold token and an email turns held tickets into sold ones: the hold is consumed in Redis — hash and index entry removed in one script, nothing restored — and then `orders`, `order_items` and the hold's row flipped to `converted` land in one Postgres transaction. An expired, released or already-confirmed hold is `410 Gone`. `orders.idempotency_key` gained its `UNIQUE` constraint, filled from an optional header until TB-030 makes it required; a reuse is `409`. The live counter never moves on a sale: the tickets go from held to sold without passing through available, and the computed count subtracts them from a different column. Smoke places one real order per run.

---

## How it works

```
POST /orders { holdToken, email }  [Idempotency-Key]
  find(token)              → null, or expired by the entity's clock → 410
  findById(hold.eventId)   → the tier's price (missing → a bug, 500)
  Order.create(...)        validated before any write
  consume(token)           consume_hold.lua: EXISTS → tierId check → member built → DEL hash → ZREM entry → 1
                           -1 (expired, swept, released, confirmed) → 410; nothing written
  orders.save(order)       BEGIN
                             UPDATE holds SET status='converted' WHERE token=$1 AND status='active'   — exactly one row, or throw
                             INSERT orders (… idempotency_key)   — 23505 on the named constraint → IdempotencyKeyReused → 409
                             INSERT order_items
                           COMMIT
  201 { orderId, totalCents, items, createdAt }
```

**Redis decides, Postgres records (ADR 0007).** The other order lets the sweeper restore a ticket an order already owns. With this order a Postgres failure after the consume leaves the hold gone and no order — tickets off sale until reconcile expires the row, never two owners. A retry is a 410, not a second attempt, so there is nothing to compensate for.

**The flip is the transaction's first statement.** A hold with no row at all and a hold whose row is `expired` or `released` fail at the same guard with the same message, the row lock is taken before any insert, and nothing is written that the rollback has to undo. A reconcile racing the confirm waits on that lock or finds the row already converted.

**The entity decides expiry, as `GetHold` does.** The first version let the Redis TTL alone decide; in the skew between the application's clock and Redis's, the checkout page would say expired while the confirm succeeded. The clock is read once, after the lookup, and the order's `createdAt` is that same instant.

**Three scripts, one hold, one winner.** At the expiry instant the confirm, the sweeper and a late release each take a receipt — the hash for two of them, the entry for the sweeper — and each removes both keys. Issued in both orders against real Redis: the counter ends at 6 (confirm won) or 10 (sweep won), never 14.

### Layers touched

| Layer                                     | What changed                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | `Order.idempotencyKey` (optional prop, `string \| null` on the entity, empty refused); `errors/HoldGone`, `errors/IdempotencyKeyReused` (new)                                                                                                                                      |
| L2 `application/**`                       | `ports/HoldStore.consume`; `ports/OrderRepository` contract spelt out; `ports/OrderIdGenerator` (new); `use-cases/ConfirmOrder.ts` (new)                                                                                                                                           |
| L3 `infrastructure/**`, `presentation/**` | `scripts/lua/consume_hold.lua` (new); `RedisHoldStore.consume`; `postgres/PgOrderRepository.ts` (new, Pool-only); `UuidTokenGenerator` implements `OrderIdGenerator`; `dto/orders.ts`, `OrderController`, `routes/orders.ts` (new); two rows in `errors.ts`; `server.ts`: `orders` |
| L4 `main/**`                              | `composition.ts`: `PgOrderRepository(pool)`, `ConfirmOrderUseCase`, `OrderController`                                                                                                                                                                                              |
| migrations                                | `007_orders_idempotency_key.sql`: nullable `text`, constraint named `orders_idempotency_key_key`                                                                                                                                                                                   |
| test fakes                                | `InMemoryHoldStore.consume`; `stubHoldStore`; `FixedTokenGenerator.nextOrderId`; `InMemoryOrderRepository` (new, flips the hold row through the injected mirror); `unusedOrderController()`                                                                                        |

### Key files

| File                                                            | What it does                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lua/consume_hold.lua`                                  | the receipt and the no-restore; the header names the three-way race and the error contract                                   |
| `packages/api/src/application/use-cases/ConfirmOrder.ts`        | find → expiry by the entity → price → consume → record; the two windows ADR 0007 names, in the header                        |
| `packages/api/src/infrastructure/postgres/PgOrderRepository.ts` | the transaction, flip first; `23505` on the named constraint → `IdempotencyKeyReused`; a clean rollback keeps its connection |
| `packages/api/src/presentation/http/routes/orders.ts`           | `POST /orders` 201/400/409/410; the body with the email is never logged                                                      |
| `docs/adr/0007-redis-consumes-before-postgres-records.md`       | the order of the two writes, five alternatives, the two windows left open                                                    |

### Redis keys introduced

| Key      | Type | TTL | Who writes it                                                                 | Who reads it |
| -------- | ---- | --- | ----------------------------------------------------------------------------- | ------------ |
| none new |      |     | `hold:<token>` and `tier:<id>:holds` gain a third remover: `consume_hold.lua` |              |

### Lua scripts introduced

| Script             | The race it prevents                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `consume_hold.lua` | a sweep landing between "is it held" and "now it is sold", restoring a ticket about to be sold; and the entry outliving the hash (ADR 0006) |

---

## 3. Where this diverged from the plan

| Planned                                                                | What actually happened                                                                                                                   | Why                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision 5: `find(token)` → `null` → gone; the Redis TTL alone decided | …or `hold.isExpired(now)`; the clock read once after the lookup; `createdAt: now`                                                        | **Review Major:** `GetHold` asks the entity and the confirm did not — in the clock skew the page would say expired while the confirm succeeded. "The entity, not the caller, decides what expired means."        |
| Decision 2: the hold's flip last in the transaction                    | First, with the one-row guard                                                                                                            | Review Major: a hold with no row hit the foreign key with a different message; first, one guard, the row lock before any insert, nothing to undo.                                                                |
| §6 answered "runs twice" as "same key twice is a 409"                  | …and a reused key on a _different_ hold burns the hold: consumed, no order, row `active`                                                 | Review Major: the one path where a well-formed request loses a hold; ADR 0007 and a route test pin it for TB-030.                                                                                                |
| §6 did not name reconcile racing a confirm                             | Between the consume and the commit, reconcile's "gone from both → expire" fires; the confirm's UPDATE touches no row → 500, tickets back | Review Major: one lost sale, never an oversell; the window is one statement wide; not widened. Reconcile's over-count by one noted.                                                                              |
| `release(err)` on every catch path                                     | Only when the ROLLBACK itself failed                                                                                                     | Re-review Minor: a refused idempotency key must not cost the pool a connection; tested (`totalCount` flat across five refusals).                                                                                 |
| The consume script built the member after the `DEL`                    | Before it                                                                                                                                | Review Minor: a hash with no `qty` raised after the delete; the sibling scripts promise "on an error, nothing is written" and now this one does too (tested).                                                    |
| §5: the confirm-vs-sweep race as `Promise.all` through the adapters    | The two scripts issued directly, in both orders                                                                                          | Found by sabotage: the adapter's consume reads the tier first, so on one connection the sweep always won and the consume-wins branch never ran; an `HINCRBY` added to the script stayed green until the rewrite. |
| The smoke suite's order on the first seed event                        | On the second seed event's first tier                                                                                                    | A sale cannot be undone and every E2E reads the first event's numbers; the second event is read by nothing.                                                                                                      |
| `ConfirmOrderInput.idempotencyKey?: string`                            | `string \| null`, the controller passing `?? null`                                                                                       | Review Minor: one conditional spread instead of two.                                                                                                                                                             |
| `HoldStore` growing to seven methods                                   | Unchanged here; recorded as a stage-boundary follow-up                                                                                   | Review Major 5: the port is now splittable along use-case seams; not this PR's.                                                                                                                                  |

---

## 4. Tests shipped

| Level       | Test file                                                   | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/application/use-cases/ConfirmOrder.test.ts`      | a live hold → an order at the tier's price, **total correct**, row `converted`, hold gone, **tickets not given back**; **expired → gone** (by the store, and by the entity with the store still answering — `consume` never called); **already confirmed → gone, one order**; released → gone; the store refusing between read and consume → gone, nothing written; **a record failing after the consume escapes with the hold gone and no order**; reconcile expiring the row between consume and record fails the confirm, not the audit trail; the clock read once; the key carried or `null`; a missing event is a bug |
| Unit        | `test/unit/domain/entities/Order.test.ts`                   | the key kept, `null` when absent, empty refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Integration | `test/integration/redis/RedisHoldStore.test.ts` (`consume`) | hash and entry gone, **counter unchanged**; twice and unknown → false; after a release or a sweep → false; **after a consume, sweep is `swept: false` and release `released: false`, counter unchanged**; the tier-mismatch guard; a hash with no `qty` throws with nothing written; fails fast offline                                                                                                                                                                                                                                                                                                                    |
| Concurrency | `test/integration/redis/RedisHoldStore.concurrency.test.ts` | **50 concurrent confirms of one hold: exactly one `true`, counter exactly 6, ×10**; **the confirm and the sweep at one hold in both orders: one winner, the counter 6 or 10, never 14**                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Integration | `test/integration/postgres/PgOrderRepository.test.ts`       | the order, its items and the flip land together and **the computed count does not move**; a non-active row and a missing row both write nothing; **a failing item leaves no partial order and the row `active`**; a reused key → `IdempotencyKeyReused`, nothing written, the other hold's row still `active`; a second order for one hold stops at the guard; a confirm and an expiry on one row: exactly one lands; five refused keys grow the pool by at most one                                                                                                                                                       |
| Integration | `test/integration/postgres/migrations.test.ts`              | 007 names its constraint; two `NULL` keys admitted; two equal keys refused with the constraint's name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Integration | `test/integration/http/orders.test.ts`                      | 201 with the body; the header carried; **410 `GONE`, not 404**; the second confirm 410 with one order; **a reused key on a different hold → 409 and that hold consumed with no order**; 400 for a bad token, a bad email, a 201-character key; neither the email nor the key in the log at info                                                                                                                                                                                                                                                                                                                            |
| Integration | `test/integration/main/composition.test.ts`                 | through the real stack: hold → confirm 201 → the page's number unchanged, counter unchanged, row `converted`, `GET /holds` 404, second confirm 410, the sweeper finds nothing, reconcile reports nothing; a hold reconcile expired first → 410, row `expired`, tickets back on sale, no order                                                                                                                                                                                                                                                                                                                              |
| Smoke       | `test/smoke/smoke.test.ts`                                  | `POST /holds` → `POST /orders` 201 on the second seed event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E2E         | —                                                           | none — E2E-2's second half and E2E-5 are TB-030's, with the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Final run on `5b07bd6`: typecheck clean, `lint --max-warnings 0` clean, api unit **210**, api integration **232** (19 files), smoke **7** against the API restarted on this branch.

**Proven able to fail** — eight sabotages, each restored from git:

```
S1  HINCRBY added to consume_hold.lua             "leaves the counter where it was": ×;  "when the confirm runs first it wins": ×  (green before the race test was rewritten — see §3)
S2  ZREM dropped from consume_hold.lua            "a sold ticket is never restored": ×
S3  the hold's flip outside the transaction       "no partial order when a statement fails mid-transaction": ×
S4  the status = 'active' guard dropped           "writes nothing for a hold whose row is not active": ×
S5  Postgres before Redis in the use case         "a failed record escapes with the hold already consumed": ×
S6  the entity's expiry check dropped             "asks the entity, not only the store": ×
S7  410 mapped to 404                             "answers 410 GONE, not 404": ×
S8  the unique constraint dropped from 007        "names the idempotency constraint": ×
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It verified `gen_random_uuid()` on Postgres 16 and that the zod header schema does not strip other headers, proved the consume script's error ordering on DB 9 before and after the fix, and read the pool's release semantics.
**Verdict:** **SAFE TO MERGE** with five Majors to settle before Phase 4 → two coded, two documented and pinned, one deferred (`2a7c33c9`) → re-review: **SAFE TO MERGE**, one Minor (fixed).

| Finding                                                                                                                                                                           | Severity | Resolution                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------- |
| The confirm let the Redis TTL alone decide expiry while `GetHold` asks the entity                                                                                                 | Major    | `hold.isExpired(now)`; clock read once                  |
| A reused key on a fresh hold burns the hold                                                                                                                                       | Major    | ADR 0007; route test pinned for TB-030                  |
| Reconcile racing a confirm between consume and commit                                                                                                                             | Major    | ADR 0007; flip first; composition test of the mechanics |
| The flip last: a missing row hit the FK with another message                                                                                                                      | Major    | Flip first, one guard, row lock before inserts          |
| `HoldStore` at seven methods for one more consumer                                                                                                                                | Major    | Deferred to the stage boundary (follow-up)              |
| Member built after the `DEL`; unnamed constraint; `release(err)` on every path (two rounds); `{ ...item }`; two spreads; ADR 0007 cited before it existed; the fake's check order | Minor    | All applied or recorded                                 |

Findings deliberately **not** fixed: the port split (Major 5), by the reviewer's own framing.

---

## 6. Failure modes, as built

- **Redis down:** `find` throws at `requireReady` → 500, nothing written. A consume whose reply is lost: the hold is gone, no order, a retry is a 410 — the under-sell, repaired by reconcile.
- **Postgres down after the consume:** the same under-sell (tested at the unit level with a throwing repository). Before it: nothing written.
- **Key evicted under `allkeys-lru`:** the hash → 410 while the timer runs, the sweeper restores from the entry; the entry → the consume takes the hash, the leftover is nothing.
- **Runs twice:** the second confirm of one hold is a 410 (the hash was the receipt; tested 50-wide). The same key twice is a 409; on a different hold the 409 also burns that hold (tested, and ADR 0007's first window).
- **Dies halfway:** between consume and commit → the under-sell; inside the transaction → nothing written (the flip is first, the rollback has nothing to undo); between the reply and the client → the order exists and the client does not know (TB-030).
- **Confirm vs sweep vs release at the expiry instant:** one winner, both orders tested; the counter never gains twice.
- **Reconcile vs confirm:** one statement wide; the confirm loses, the tickets return to sale, one lost sale (tested by hand through the composed system).
- **The email:** the body is never logged; tested against the pino stream at info.

---

## 7. What I'd do differently

Check that a race test can see both winners before trusting it: the first version was green ten times because the same side always won, and only a sabotage that should have gone red said so. And ask the sibling use case what it does before writing a new one — `GetHold` had already decided who defines expiry.

---

## 8. Follow-ups left behind

- [ ] TB-030: the `Idempotency-Key` header required; the Redis layer answering a retry with the first order — which also closes the burned-hold window (ADR 0007), whose route test is red for it today; the Confirm button and the email field on the checkout page, with E2E-2's second half and E2E-5.
- [ ] TB-031: a lock the confirm could hold for its three statements, closing the reconcile window.
- [ ] TB-027's doc: `rowsExpired` over-counts by one when the confirm's row lock wins the race.
- [ ] Stage boundary: `HoldStore` is seven methods for four consumers (`reserve/release`, `find`, `expired/sweep`, `consume`); a split along those seams, with `InventoryRepair` as the precedent.
- [ ] `InMemoryOrderRepository` checks the idempotency key before the hold token; Postgres checks its unique indexes in creation order. Unreachable through the use case; no test may encode either order.
