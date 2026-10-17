# TB-007 — Ports

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-007 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-007-ports.md`](../implementation-plans/TB-007-ports.md)
**Branch / PR:** `feat/TB-007-ports` · [#10](https://github.com/Hanna-Hinn/Ticketbox/pull/10) (based on #9)
**ADR:** none — the Redis/Postgres split these ports encode is the handbook's (§1.4), not a new decision.

---

## What this task delivered

Layer 2's contract with everything outside it: eight interfaces under `packages/api/src/application/ports/`, named for what the domain needs and carrying only domain types and plain result objects. No implementation, no fake — those are TB-008 (in-memory), TB-010 (Postgres) and TB-022 (Redis). The Dependency Rule is now visible as code: `application/` imports `domain/` and nothing else.

---

## How it works

```
Clock.now(): Date                                   TokenGenerator.next(): HoldToken
EventRepository.findById / listUpcoming(now)        TicketTierRepository.findById
HoldStore.reserve(tierId, qty, token, ttlMs) → { ok, remaining } | { ok: false, reason: "insufficient" }
         .release(token)                     → { released: true, tierId, remaining } | { released: false }
         .availability(tierIds)              → ReadonlyMap<TierId, number>
HoldRepository.save(hold) / setStatus(token, HoldOutcome)     HoldOutcome = converted | expired | released
OrderRepository.save(order)
EventPublisher.availabilityChanged({ eventId, tierId, remaining })
```

Two ports for one concept is the lesson: `HoldStore` is Kind B (live, self-expiring, rebuildable — Redis), `HoldRepository` is Kind A (the audit trail — Postgres). Expected failures (`insufficient`, `released: false`) are values in the return type; a dead connection is a throw from the adapter, which is why the result types carry no `"unavailable"` reason.

### Layers touched

| Layer                   | What changed               |
| ----------------------- | -------------------------- |
| L1 `domain/**`          | None                       |
| L2 `application/ports/` | New: eight interface files |
| L3–L4                   | None                       |

### Key files

| File                                   | What it does                                                         |
| -------------------------------------- | -------------------------------------------------------------------- |
| `application/ports/HoldStore.ts`       | The atomic reserve / compare-and-restore release / availability      |
| `application/ports/HoldRepository.ts`  | The mirror: `save` writes `active`; `setStatus` takes an outcome     |
| `application/ports/EventPublisher.ts`  | `availabilityChanged` — one method, one payload, three causes        |
| `application/ports/EventRepository.ts` | `findById`, `listUpcoming(now)` — tiers always loaded                |
| the other four                         | `Clock`, `TokenGenerator`, `TicketTierRepository`, `OrderRepository` |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                          | What actually happened                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HoldStore.availability(eventId)` — the handbook §2.3 signature, copied verbatim | **`availability(tierIds)`.** The review pointed out that `reserve`/`release` are keyed on tiers while `availability` was keyed on an event the store knows nothing about: `InMemoryHoldStore` would have needed a seeding API outside the interface, and `RedisHoldStore` an `event:{id}:tiers` index key that TB-027 would then have to rebuild. The caller already holds the `Event` with its tiers. | The handbook's own example signature was internally inconsistent; the plan inherited it. Caught before any implementation existed, which is the cheapest moment.                       |
| `release(token) → { released: boolean }`                                         | `{ released: true; tierId; remaining }                                                                                                                                                                                                                                                                                                                                                                 | { released: false }`.                                                                                                                                                                  | The release use case holds only a token; it cannot ask for the new count afterwards, and TB-023 + TB-037 need "tier X now has N" to publish. The script already knows both. TB-023's literal `{released: false}` test still holds. |
| `EventPublisher.holdCreated(change)` — the handbook §2.5 trace                   | `availabilityChanged(change)`.                                                                                                                                                                                                                                                                                                                                                                         | Created, released and swept holds all produce the same payload and subscribers consume only the effect; one method per cause was an interface-segregation problem scheduled for later. |
| `HoldRepository.setStatus(token, HoldStatus)`                                    | `setStatus(token, HoldOutcome)` with `HoldOutcome = Exclude<HoldStatus, "active">`.                                                                                                                                                                                                                                                                                                                    | A use case that could rewind `converted` to `active` could rewrite the audit trail. Now a compile error.                                                                               |
| Decision 1 (drop `findWithTiers`) stated without its cost                        | Plan decision 9 added: `listUpcoming` must compute availability for every tier of every upcoming event even though the list page reads none of it — the query TB-013 benchmarks and TB-018 caches.                                                                                                                                                                                                     | Review Major 3. Not a TB-007 change; written down so TB-010's plan confronts it instead of inheriting it.                                                                              |
| —                                                                                | Plan decisions 10–11 added: TB-029's one-transaction/two-ports problem (`OrderRepository.save` vs `HoldRepository.setStatus`), an `OrderId` source, what `reserve` means when the counter key is absent, and which clock the sweeper's ZSET score comes from.                                                                                                                                          | Review Majors 5 and Minors. Recorded now so those tasks' plans start from the question rather than discovering it in Phase 2.                                                          |

---

## 4. Tests shipped

None — "types only", per the Tests line. What stands in for tests:

- `pnpm typecheck` passes with every port importing only `domain/**`; verified by grep (TB-009 turns that into a lint failure).
- The eight file names contain no technology word (the Acceptance line).
- After the `HoldOutcome` change, `setStatus(token, "active")` is a compile error — the one thing the type system now proves that it did not before.

**Coverage after this task:** unchanged — interfaces produce no runtime code.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool; reviewed each signature against the task that will implement it and the task that will call it.
**Verdict:** SAFE TO MERGE (no Critical), with four signature changes recommended "while there are zero implementations" — all four applied — and three plan annotations, all recorded.

| Finding                                                                                              | Severity | Resolution                                                             |
| ---------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `reserve(tierId)` vs `availability(eventId)`: the store cannot know event membership                 | Major    | `availability(tierIds)`                                                |
| `holdCreated` encodes the cause; subscribers consume the effect; `holdReleased`/… would follow       | Major    | `availabilityChanged`                                                  |
| Decision 1's cost (`listUpcoming` computes availability nobody on the list page reads) unrecorded    | Major    | Plan decision 9, for TB-010                                            |
| `setStatus` accepted `"active"`: the audit trail was rewritable                                      | Major    | `HoldOutcome`                                                          |
| `OrderRepository.save` + `HoldRepository.setStatus("converted")` cannot share TB-029's transaction   | Major    | Plan decision 10, for TB-029; no unit-of-work port added (speculative) |
| `release` threw away the tier and new count the script already has                                   | Minor    | Richer result type                                                     |
| No `OrderId` source for TB-029; "insufficient" vs missing counter key; two clocks for the ZSET score | Minor    | Plan decision 11, for TB-022 / TB-029                                  |
| `EventRepository` comment argued the opposite of its point                                           | Minor    | Reworded                                                               |

Findings deliberately **not** fixed: none. Not re-dispatched for re-review: no Critical, and every change is a signature the reviewer itself proposed.

---

## 6. Failure modes, as built

- **Redis down:** a port cannot be down. The `HoldStore` adapter throws; the result type deliberately has no `"unavailable"` reason so infrastructure state never leaks into use cases. TB-039 decides per endpoint whether that is fail-open or fail-closed.
- **Key evicted under `allkeys-lru`:** the adapter's problem (TB-022, TB-040). Noted in plan decision 11 that the port cannot distinguish "sold out" from "counter key missing" — TB-022 must decide whether it needs to.
- **Operation runs twice:** `release` is shaped so "already released" is `{ released: false }`, a value; `setStatus` cannot rewind. The idempotency of each adapter is specified by the task that builds it.
- **Dies halfway through:** N/A — interfaces.

---

## 7. What I'd do differently

Not copy a signature "verbatim" without asking what each parameter is keyed on. The handbook's `HoldStore` example mixed tier-keyed and event-keyed methods, and copying it faithfully would have cost a fake, an adapter and a reconcile step before anyone noticed.

---

## 8. Follow-ups left behind

- [ ] TB-010: decide whether `listUpcoming` needs the full availability computation or a lighter list shape (plan decision 9).
- [x] TB-022: define `reserve` on a missing counter key (refused as `insufficient`, with a warn naming the tier); name the clock behind the ZSET score (the use case's `Clock`, carried by the `Hold` entity — `reserve` takes the entity now).
- [x] TB-029: one transaction across orders, order_items and the hold's status (decision 10); an `OrderId` source (decision 11). _`OrderRepository.save` owns the transaction, flip first; `OrderIdGenerator` on `UuidTokenGenerator` (ADR 0007)._
- [ ] TB-033/034: the stream publisher is a different port from `EventPublisher`, not a second method on it (decision 5).
