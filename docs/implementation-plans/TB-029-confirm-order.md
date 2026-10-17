# TB-029 — ConfirmOrder use case

**Status:** Implemented — see [`docs/tasks/TB-029-confirm-order.md`](../tasks/TB-029-confirm-order.md)
**Date:** 2026-10-17
**Task:** TB-029 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-029-confirm-order` (stacked on `feat/TB-028a-e2e-expiry-journey`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decisions 1, 2 and 3 are the ones to read first**: Redis consumes before Postgres records, the order repository owns the hold's `converted` flip, and a hold with no row cannot be confirmed.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** `ConfirmOrderUseCase` — validate the hold is still alive, create `orders` + `order_items` in one Postgres transaction, mark the hold `converted`, and consume it in Redis so the sweeper won't restore it. `UNIQUE` constraint on `orders.idempotency_key`. `POST /orders`.

**Acceptance:** confirming a live hold produces an order; confirming an expired hold returns 410 Gone.

**Tests:** **unit** — expired hold rejected; already-converted hold rejected; total computed correctly. **Integration** — the order and items land in one transaction; a mid-transaction failure leaves no partial order.

**Depends on:** TB-020, TB-024 — confirmed merged: ☐ (stacked: #24 and #28 are open, not merged, by the session's instruction; this branch contains them)

---

## 2. What I understand this to mean

The product's one irreversible step. A hold is alive in Redis; confirming it turns held tickets into sold ones: an `orders` row with its `order_items` and the hold's row flipped to `converted`, all in one Postgres transaction, and the hold **consumed** in Redis — its hash and its index entry removed together, with no restore, because the tickets are no longer held, they are sold. The live counter does not move: it already excludes those tickets, and the computed count now subtracts them as `order_items` instead of as an active hold (TB-010's "disjoint sums" invariant, which this transaction is what keeps true). An expired hold — or one already confirmed, or released: Redis cannot tell them apart, and neither should the response — is `410 Gone`. `orders.idempotency_key` gets its `UNIQUE` constraint in a new migration; the header that fills it is optional here and required in TB-030, where the Redis layer that makes a retry return the same order arrives. The Confirm button and the email field are not in this Scope line; they ride with TB-030's E2E-5, which cannot exist without them.

---

## 3. Approach

### Layers touched

| Layer                                     | What changes                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | `Order` gains `idempotencyKey: string \| null`; `errors/HoldGone.ts`, `errors/IdempotencyKeyReused.ts` (new)                                                                                                                                                                                                         |
| L2 `application/**`                       | `ports/HoldStore.ts`: `consume(token)`; `ports/OrderRepository.ts`: the contract spelt out (one transaction, the hold's flip inside it); `ports/OrderIdGenerator.ts` (new); `use-cases/ConfirmOrder.ts` (new)                                                                                                        |
| L3 `infrastructure/**`, `presentation/**` | `scripts/lua/consume_hold.lua` (new); `redis/scripts.ts`, `RedisHoldStore.consume`; `postgres/PgOrderRepository.ts` (new); `system/UuidTokenGenerator` implements `OrderIdGenerator`; `dto/orders.ts`, `controllers/OrderController.ts`, `routes/orders.ts` (new); `http/errors.ts`: two rows; `server.ts`: `orders` |
| L4 `main/**`                              | `composition.ts`: `PgOrderRepository(pool)`, `ConfirmOrderUseCase`, `OrderController`                                                                                                                                                                                                                                |
| migrations                                | `007_orders_idempotency_key.sql`                                                                                                                                                                                                                                                                                     |

### Decisions this plan is making

1. **Redis consumes first; Postgres records second (ADR 0004's rule, applied to the irreversible step).** The order of the two writes decides which failure the system can have. _Postgres first:_ the order commits, then Redis is unreachable — the hold stays alive, the sweeper restores its quantity at expiry on top of a sold ticket: **an oversell**, and the exact entry-behind-a-non-active-row ADR 0006 forbade. _Redis first:_ the hold is consumed, then Postgres fails — no order, the hold gone, its tickets neither sold nor restorable: **an under-sell** by `qty`, visible as a row left `active` whose hold is gone, which reconcile (TB-027) expires and whose quantity it then stops subtracting. The caller gets a 500 and a checkout page that says the hold is gone; a retry is a 410, not a second attempt, so there is no amplification to compensate for (unlike TB-024's reserve/save). Safe direction, repairable by the existing tool, no compensation code.

2. **`OrderRepository.save(order)` writes `UPDATE holds SET status = 'converted' WHERE token = $1 AND status = 'active'` — first, and it must touch exactly one row — then `orders` and `order_items`, in one transaction** **(amended in review: the flip was last; first, a hold with no row at all and a hold with a non-active row fail at the same guard with the same message instead of one hitting the foreign key, the row lock is taken before any insert, and nothing is written that the rollback has to undo)**. TB-007 decision 10 named this the one-transaction/two-ports problem and declined a unit-of-work port as speculative; the answer is that the order's repository owns the whole write, because "a hold that got confirmed" _is_ the order (the entity's own definition) and the row's flip is part of recording it, not a second fact. `HoldRepository.setStatus` is not called for `converted`. Zero rows updated means the mirror has no active row for a hold Redis just consumed: decision 3.

3. **A hold with no active row cannot be confirmed; the transaction rolls back and the request is a 500.** The row is missing only in ADR 0004 row 1 (save failed and the compensating release failed too) or already non-active while the hash lives, which no writer produces. Inserting the missing row here would be the thing ADR 0006 declined for reconcile, for the same reason: an order whose hold Postgres never recorded is a history Postgres cannot explain. The hash is consumed by then (decision 1): the tickets sit un-sellable until reconcile expires the row — the same under-sell as any Postgres failure after the consume. Rare, safe, repaired by the existing tool; TB-027's open question answered: **no**.

4. **`consume_hold.lua`: the hash is the receipt; no restore.** `EXISTS hold == 0 → -1`; `HGET tierId ~= ARGV → -1` (the caller's prelude read, as in `release_hold.lua`); `qty = HGET`; `DEL hold`; `ZREM tier:holds "<token>:<qty>"`; `return 1`. The header names the race: a confirm racing the sweeper or a release at the expiry instant — whoever takes the hash wins, and the other two find nothing. Confirm vs sweep: if the sweep won, the quantity is back in the counter and the confirm is a 410 — correct, the customer was late. If the confirm won, the sweeper's `ZSCORE` finds no entry — correct, nothing to restore. **No `HINCRBY` anywhere: the tickets leave "held" for "sold" without passing through "available".** Removing the hash and the entry in one script is ADR 0006's constraint, met. Deadline and `requireReady` as the other write commands.

5. **The use case's sequence:** `find(token)` → `null` **or `hold.isExpired(now)`** → `{ ok: false, reason: "hold-gone" }` **(amended in review: the first version let the Redis TTL alone decide while `GetHold` asks the entity, so in the skew between the app's clock and Redis's the checkout page could say expired while the confirm succeeded; the entity decides here as it does there, the consume stays the decision)**; `events.findById(hold.eventId)` and the tier by `hold.tierId` → `null`/missing → throw (a hold references an event that exists; its absence is a bug); build the `Order` (`id` from `OrderIdGenerator`, `holdToken`, `email`, one item `{ tierId, qty, unitPrice: tier.price }`, `createdAt: clock.now()`, `idempotencyKey`); `holds.consume(token)` → `false` → `hold-gone` (it expired, or was released or confirmed, between the read and now — the script is the decision, the `find` was the data); `orders.save(order)`; return `{ ok: true, orderId, totalCents, items }`. The clock is read once. `Order.total()` is the entity's; the controller sends `totalCents`.

6. **`idempotency_key`: a nullable `text UNIQUE` column in `007_orders_idempotency_key.sql`, filled from an optional `Idempotency-Key` header, duplicates refused by the constraint.** Postgres `UNIQUE` admits any number of `NULL`s, so a request without the header is unconstrained — TB-030 makes the header required and adds the Redis layer that turns a duplicate into the first response instead of a refusal. Here a duplicate is the constraint's `23505` on `orders_idempotency_key_key`, translated by the adapter into `IdempotencyKeyReused` → `409 CONFLICT`. The constraint is the truth; TB-030's acceptance line ("bypass Redis and confirm Postgres still refuses") depends on it existing now. `orders.hold_token UNIQUE` (TB-004) already makes a second order for the same hold impossible, and decision 4 makes it unreachable: the second confirm is a 410 before any row is written.

7. **`POST /orders`** body `{ holdToken: uuid, email: email }`, header `Idempotency-Key` optional (`z.string().min(1).max(200)` when present); `201 { orderId, holdToken, email, totalCents, items: [{ tierId, qty, unitPriceCents }], createdAt }`; `410 GONE` for `hold-gone` (`HoldGone`, a new row in the error table — the first 410, named for what it is: the resource existed and will not again); `409 CONFLICT` for a reused key; `400` from the schema. The email is validated as an email and **never logged** (CLAUDE.md); the controller maps and the route declares.

8. **`OrderIdGenerator { nextOrderId(): OrderId }`**, implemented by `UuidTokenGenerator` beside `TokenGenerator` (TB-007 decision 11's "an `OrderId` source"). A second interface on the same class, not a second class: both are "a v4 UUID from the CSPRNG" and the use case that needs the one never needs the other.

9. **The web is untouched.** No Confirm button, no email field, no `createOrder` in the client: the Scope line is the use case and the route. TB-030 carries the UI with E2E-5, because the double-click it tests is the UI. Noted in §8 and the task doc; TB-025's follow-up ("`CheckoutPage` gains Confirm") moves to TB-030.

10. **Could Postgres already do this?** §7 — this is the one task where it mostly does: the transaction is the whole guarantee on the recording side. Redis's part is the consume, which exists only because the live hold exists.

### New or changed ports

```ts
// application/ports/HoldStore.ts
/**
 * Take the hold out of the store for good — sold, not released: nothing is
 * restored. false: there was nothing to consume (expired, released, already
 * confirmed; the store cannot tell which and the caller does not need to).
 */
consume(token: HoldToken): Promise<boolean>;

// application/ports/OrderRepository.ts
/**
 * One transaction: the order, its items, and the hold's row flipped to
 * 'converted' — the three facts that make "a hold that got confirmed" true
 * together or not at all (TB-007 decision 10, TB-010's disjoint sums).
 * Throws when the hold has no active row to flip (nothing is written) and
 * IdempotencyKeyReused when the key is already an order's.
 */
save(order: Order): Promise<void>;

// application/ports/OrderIdGenerator.ts
export interface OrderIdGenerator { nextOrderId(): OrderId }
```

Fakes: `InMemoryHoldStore.consume` (delete, no restore; `false` if absent or expired); `InMemoryOrderRepository` (new: `save` throws on a reused key or a reused hold token, records the hold flip through an injected `InMemoryHoldRepository` so the unit tests see `converted`); `stubHoldStore.consume`; `FixedTokenGenerator` gains `nextOrderId`.

### Redis keys

None new. `hold:<token>` and `tier:<id>:holds` gain a third remover, `consume_hold.lua`.

### Lua scripts

**`scripts/lua/consume_hold.lua`** — KEYS: `[1]` hold hash, `[2]` tier holds zset. ARGV: `[1]` token, `[2]` tierId (the prelude read's answer; the script checks it still is). Returns `1` consumed; `-1` nothing to consume. Writes nothing on `-1`. The race in the header: decision 4.

### Migrations

`migrations/007_orders_idempotency_key.sql`: `ALTER TABLE orders ADD COLUMN idempotency_key text UNIQUE;` — nullable, with the comment that TB-030 makes the header mandatory while the column stays nullable for history.

---

## 4. Files

| File                                                                                                                   | New / Changed | Why                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------- |
| `migrations/007_orders_idempotency_key.sql`                                                                            | New           | decision 6                                           |
| `scripts/lua/consume_hold.lua`                                                                                         | New           | decision 4                                           |
| `packages/api/src/domain/entities/Order.ts`                                                                            | Changed       | `idempotencyKey`                                     |
| `packages/api/src/domain/errors/{HoldGone,IdempotencyKeyReused}.ts`                                                    | New           | decisions 6, 7                                       |
| `packages/api/src/application/ports/{HoldStore,OrderRepository}.ts`, `ports/OrderIdGenerator.ts`                       | Changed / new | the contracts                                        |
| `packages/api/src/application/use-cases/ConfirmOrder.ts`                                                               | New           | decision 5                                           |
| `packages/api/src/infrastructure/redis/{scripts,RedisHoldStore}.ts`                                                    | Changed       | `consumeHold`, `consume`                             |
| `packages/api/src/infrastructure/postgres/PgOrderRepository.ts`                                                        | New           | decision 2                                           |
| `packages/api/src/infrastructure/system/UuidTokenGenerator.ts`                                                         | Changed       | decision 8                                           |
| `packages/api/src/presentation/dto/orders.ts`, `http/controllers/OrderController.ts`, `http/routes/orders.ts`          | New           | decision 7                                           |
| `packages/api/src/presentation/http/{errors,server}.ts`                                                                | Changed       | two rows; `orders` dep                               |
| `packages/api/src/main/composition.ts`                                                                                 | Changed       | wiring                                               |
| `packages/api/test/fakes/{InMemoryHoldStore,stubHoldStore,FixedTokenGenerator}.ts`, `fakes/InMemoryOrderRepository.ts` | Changed / new | the fakes                                            |
| `packages/api/test/integration/http/support.ts` + the six route tests that build the server                            | Changed       | `unusedOrderController()`                            |
| `packages/api/test/unit/application/use-cases/ConfirmOrder.test.ts`                                                    | New           | §5                                                   |
| `packages/api/test/unit/domain/entities/Order.test.ts`                                                                 | Changed       | `idempotencyKey`, if the entity test exists          |
| `packages/api/test/integration/redis/{RedisHoldStore,RedisHoldStore.concurrency}.test.ts`                              | Changed       | `consume`; confirm vs sweep vs release, exact count  |
| `packages/api/test/integration/postgres/{PgOrderRepository,migrations}.test.ts`                                        | New / changed | the transaction; 007                                 |
| `packages/api/test/integration/http/orders.test.ts`                                                                    | New           | the route                                            |
| `packages/api/test/integration/main/composition.test.ts`                                                               | Changed       | confirm through the real stack                       |
| `packages/api/test/smoke/smoke.test.ts`                                                                                | Changed       | `POST /orders` on a fresh hold (one more smoke case) |
| `docs/adr/0007-redis-consumes-before-postgres-records.md`                                                              | New           | decisions 1–3                                        |
| `docs/tasks/TB-007-…`, `TB-010-…`, `TB-024-…`, `TB-025-…`, `TB-027-…`                                                  | Changed       | the TB-029 follow-ups, closed or moved               |
| `docs/02-product-delivery-plan.md`                                                                                     | Changed       | tracker                                              |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What it would catch                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unit        | `ConfirmOrderUseCase`: a live hold → `ok`, an order saved with one item at the tier's price and the hold's qty, **total correct** (qty × price), the hold row `converted`, the hold gone from the store and **its quantity not restored**; **an expired hold → `hold-gone`**, nothing written; **a hold already confirmed → `hold-gone`** on the second call, one order; a released hold → `hold-gone`; the store refusing between read and consume → `hold-gone`, nothing written; the save throwing after the consume → the error escapes, the hold is gone, no order (decision 1's under-sell, pinned); the clock read once; the id from the generator; the idempotency key carried into the order | the sequence; the two failure directions; the money         |
| Unit        | `Order`: `idempotencyKey` kept, `null` allowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the entity                                                  |
| Integration | `consume_hold.lua` via `RedisHoldStore.consume`: a live hold → `true`, hash and entry gone, **counter unchanged**; twice → `false`; an unknown token → `false`, nothing written; after `release` → `false`; after `sweep` → `false`; **`release` after `consume` → `released: false` and the counter unchanged; `sweep` after `consume` → `swept: false`**; the tier-mismatch guard; fails fast offline                                                                                                                                                                                                                                                                                               | the script's contract and its receipt against the other two |
| Concurrency | **50 concurrent confirms of one hold**: exactly one `true`, counter unchanged, ×10; **confirm racing the sweeper on an expired-by-score hold** (`Promise.all` of `consume` and `sweep`): exactly one wins, the counter is `start` if the sweep won and `start − qty` if the confirm won — never both                                                                                                                                                                                                                                                                                                                                                                                                  | the double consume; the consume/sweep race                  |
| Integration | `PgOrderRepository.save`: the order, its items and the hold's `converted` land together; the computed count moves the quantity from held to sold and stays the same number; **a save whose hold row is not active writes nothing** (no order, no items); **a mid-transaction failure leaves no partial order** (an item violating a constraint rolls the order back); a reused idempotency key → `IdempotencyKeyReused`, nothing written; two orders for one hold → throws                                                                                                                                                                                                                            | the transaction                                             |
| Integration | migration 007 applies and is idempotent; `UNIQUE` admits two `NULL`s and refuses two equal keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the constraint                                              |
| Integration | route: 201 with the body; **410 GONE** for a token with no hold; 409 for a reused key; 400 for a bad email or token; the email absent from the log at info                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the mapping                                                 |
| Integration | composition: `POST /holds` → `POST /orders` → 201; the page's number unchanged; the hold row `converted`; `GET /holds/:token` 404; a second `POST /orders` 410; the sweeper then finds nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the wiring, both engines, the sweeper's indifference        |
| Smoke       | `POST /holds` → `POST /orders` 201 (a new, ordered hold stays sold: the smoke suite's General counter drops by one for good — **or** the smoke test reconciles after; decide in Phase 2 and record)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | the running system                                          |
| E2E         | none — E2E-2's second half and E2E-5 are TB-030's, with the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                             |

**Concurrency:** yes — the consume is an inventory path in the other direction. Exact assertions above.

**How each test will be proven able to fail:** `HINCRBY` added to the consume script (counter test red; the confirm-vs-sweep test red); `ZREM` dropped (the sweep-after-consume test red: the sweeper restores a sold ticket); the hold flip taken out of the transaction (the partial-order test red); the `status = 'active'` guard dropped (the no-active-row test red); Postgres before Redis in the use case (the save-throws test red: the hold would still be alive); the 410 mapped to 404 (route test red); the unique constraint dropped from 007 (the two-equal-keys test red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `find` throws at `requireReady` → 500, nothing written anywhere. A consume whose reply is lost (the socket drops after the script ran): the hold is gone, the order is not written, the caller gets a 500 and a retry gets a 410 — decision 1's under-sell, repaired by reconcile. The deadline bounds the wait.
- **What if Postgres is down?** After the consume: the same under-sell. Before it (`findById`): nothing written. Decision 1 chose this direction on purpose.
- **What if a key is evicted under `allkeys-lru`?** The hash: `find` is `null` → 410 for a customer whose timer is still running — the same thing GetHold already shows them; their tickets return via the sweeper (the entry survived). The entry alone: the consume still takes the hash; the entry stays and is `unrecorded` to reconcile, which subtracts it — ADR 0006's constraint is met by the script, not by the entry's survival; reconcile tolerates the leftover by design (it is the "entry present, hash gone, no active row" case, counted until the sweeper removes it, which then restores `qty` on top of a sold ticket: **an oversell by `qty`, the one eviction this task cannot absorb**. Said in the ADR; TB-040's territory).
- **What if this operation runs twice?** The second confirm of the same hold is a 410: the hash was the receipt. The same `Idempotency-Key` twice is a 409 — TB-030 turns it into the first response. **(added in review)** A reused key on a _different_ hold is the one path where a well-formed request burns a hold: the consume succeeds, the constraint refuses the order, the hold is gone and its row stays `active` — decision 1's under-sell, from a 4xx rather than an outage. The customer is told 409 and nothing about the hold. TB-030's layer answers the retry before any of this runs; until then it is in ADR 0007 and pinned by a test. A retry after a lost reply is a 410 with no order: the customer must be told, which is why TB-030 exists.
- **What if it dies halfway through?** Between consume and save: the under-sell. Inside the transaction: nothing written. Between the reply and the client: the order exists, the client does not know — TB-030.
- **Reconcile racing a confirm (added in review):** after the consume, hash and entry are gone — exactly reconcile's "gone from both → expire the row" condition. A reconcile landing between the consume and the commit flips the row to `expired`, the confirm's `UPDATE … AND status = 'active'` touches no row, the transaction rolls back, the customer gets a 500 with both engines healthy, and reconcile's rebuild puts the quantity back on sale: one lost sale, never an oversell. Not widened (accepting `expired` would rewrite the audit trail); the flip-first ordering shortens the window to one statement; ADR 0006's "run when quiet" is the operator's rule. Reconcile also counts that row as `rowsExpired` whether or not its UPDATE matched — an over-count by one in the report, noted for TB-027's doc, not fixed here.
- **Confirm vs sweep vs release at the expiry instant:** three scripts, one hash; the first one to run takes it; the two others find nothing. Tested by `Promise.all`.
- **The email:** never logged; the request body is never logged at info (CLAUDE.md). The route's schema sees it; nothing else prints it.

---

## 7. Could Postgres already do this?

Mostly, yes — and here it does. The order, the items and the hold's flip are a Postgres transaction, which is the whole guarantee on the recording side; with Postgres as the only store, "validate the hold is alive" would be `WHERE status = 'active' AND expires_at > now()` in the same transaction and there would be nothing to consume. Redis's part is one script that removes a hash and a sorted-set member, and it exists only because the live hold exists (ADR 0001); the ordering question in decision 1 exists only because there are two stores. The lesson is the size of the cross-store seam, not the transaction.

---

## 8. Open questions

None blocking. Decision 1 (Redis first) and decision 3 (no row, no order) are the ones to argue; decision 9 (no UI) is a scope reading of the Scope line, with TB-030 as the home.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0007-redis-consumes-before-postgres-records.md` — decisions 1–3
- ☑ Task doc — `docs/tasks/TB-029-confirm-order.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task

---

## 10. Amendments after implementation

- **Decision 5** gained the entity's expiry check; **decision 2** moved the flip first; **§6** gained the burned-hold and the reconcile-race windows — all in review and marked in place above.
- **§5:** the confirm-vs-sweep race is issued in both orders directly against the scripts, after a sabotage showed the adapter version only ever let the sweep win; the smoke order lands on the second seed event.
- **§4:** no file outside the list; the migrations test gained 007.
