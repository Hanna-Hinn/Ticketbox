# TB-006 — Entities and value objects

**Status:** Implemented — see [`docs/tasks/TB-006-entities-and-value-objects.md`](../tasks/TB-006-entities-and-value-objects.md); the Phase 3 review found the entities mutable through their `Date` fields (decisions 9–12 record the fixes)
**Date:** 2026-10-17
**Task:** TB-006 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-006-entities-and-value-objects` (stacked on `feat/TB-005-ci-pipeline`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `Money` (integer cents, no floats), `Quantity` (≥1, ≤10 per hold), `HoldToken`, branded `EventId` / `TierId` / `OrderId`. Entities `Event`, `TicketTier`, `Hold`, `Order`. Behaviour on the entities: `TicketTier.canFulfil(qty)`, `Hold.isExpired(now)`, `Hold.remainingMs(now)`, `Order.total()`. Domain error classes.

**Constraint:** this folder imports **nothing**. Not Zod, not a date library, nothing.

**Acceptance:** the boundary lint rule (TB-009) will later prove this; for now, check by eye.

**Tests:** **unit**, exhaustive. Money arithmetic never floats. Quantity rejects 0, -1, 11. `Hold.isExpired` at exactly the boundary instant, one ms before, one ms after. `Order.total()` across mixed tiers.

**Depends on:** TB-001 (merged, PR #2) — confirmed merged: ☑

---

## 2. What I understand this to mean

Layer 1. Plain TypeScript classes under `packages/api/src/domain/` with no `import` from outside that folder — the rules of the box office that would hold if it were run on paper. Four value objects that make invalid values unrepresentable (you cannot hold a `Quantity` of 11 or a `Money` of 19.99), four immutable entities, and the four behaviours the Scope line names. Every one of them is exercised by unit tests that need no database and finish in milliseconds.

The one real design question is where each piece of state lives — `remaining` on `TicketTier`, status on `Hold`, items on `Order` — and that is answered by what later tasks will need to call. Nothing else here is architectural, so the plan is written directly.

---

## 3. Approach

### Layers touched

| Layer          | What changes          |
| -------------- | --------------------- |
| L1 `domain/**` | New: everything below |
| L2–L4          | None                  |

### New or changed ports / Redis keys / Lua scripts / migrations

None. Ports are TB-007.

### The shapes

```
domain/
  value-objects/
    Ids.ts          EventId · TierId · OrderId  — `string & { readonly __brand: 'EventId' }` (handbook §5)
                    eventId(s) · tierId(s) · orderId(s) — the only place a plain string becomes an ID
    HoldToken.ts    HoldToken, same pattern; holdToken(s)
    Money.ts        Money.fromCents(n) · zero() · add · times(n) · equals · .cents   — integer, ≥ 0
    Quantity.ts     Quantity.of(n) · .value · MAX_PER_HOLD = 10                      — integer, 1…10
  entities/
    Event.ts        id · name · venue · startsAt · tiers: readonly TicketTier[]
    TicketTier.ts   id · eventId · name · price: Money · total · remaining            canFulfil(qty: Quantity)
    Hold.ts         token · tierId · qty: Quantity · createdAt · expiresAt            isExpired(now) · remainingMs(now)
    Order.ts        id · holdToken · email · items: readonly OrderItem[] · createdAt   total(): Money
                    OrderItem = { tierId; qty: Quantity; unitPrice: Money }
  errors/
    DomainError.ts  abstract base: sets `name` to the subclass name
    InvalidMoney.ts · InvalidQuantity.ts · InvalidHold.ts · InvalidOrder.ts · InvalidTicketTier.ts
```

Entities: `private constructor`, `static create(props)` that checks invariants and throws a `DomainError` subclass, every field `readonly`. No setters anywhere — "mutations return new instances" (CLAUDE.md rule 4), and nothing in this task mutates.

### Decisions this plan is making

1. **`Hold.isExpired(now)` is `now >= expiresAt`** — expired _at_ the boundary instant. The Scope line's three-point test (one ms before, at, one ms after) forces a choice; a hold that is "alive" at the exact instant its TTL elapses would disagree with Redis, which deletes the key at (or after) that instant. `remainingMs` is `max(0, expiresAt − now)`, never negative.
2. **`TicketTier` carries `remaining`.** The handbook defines availability as `total − sold − currently held` and TB-010 computes exactly that in SQL and "returns domain entities"; `canFulfil(qty)` needs it. Invariant: `0 ≤ remaining ≤ total`, else `InvalidTicketTier` — a negative here is a bug upstream, and TB-010's own test says "a tier with 0 remaining reports 0, never negative".
3. **Brand constructors validate nothing.** `eventId("")` returns `"" as EventId`. The brand's job is type-level: stop a `TierId` being passed where an `EventId` belongs. Shape validation (is it a UUID) is the boundary's job, with Zod, in TB-011 — "a malformed UUID returns 400 from schema validation, not from a thrown error deeper in". The cast carries the required `as` comment.
4. **`Money` is non-negative and currency-less.** One currency (€, per the handbook's examples), no refunds (§1.6), and the `CHECK (price_cents >= 0)` constraints from TB-004 say the same thing at the storage layer. `times(n)` takes a non-negative integer and is how a line total is computed: `unitPrice.times(qty.value)`.
5. **`Order` validates "at least one item" and nothing about `email`.** Email format is a boundary concern (Zod). An order with no items has no total and no meaning, so `InvalidOrder`.
6. **No status on `Hold`, no `isSoldOut` on `TicketTier`, no `HOLD_TTL_MS` constant, no `InsufficientInventory` error.** Each is a plausible addition and none is in the Scope line. The hold status (`active | converted | expired | released`) is a column on the Postgres mirror (TB-024) and will be designed there; "insufficient" is a _return value_ of the hold store, not an exception (CLAUDE.md rule 6) — the handbook's folder listing names `InsufficientInventory.ts`, but writing an error class that no code throws is speculation, so it waits for the task that needs it (and may turn out never to be needed).
7. **Errors are one class per file, with only `name` set.** The handbook's folder listing shows one file per error. No `code` field or HTTP hint: the status mapping is TB-012's, and it will key on the class.
8. **Time is `Date`.** Built in, no import, and what `Clock.now()` (TB-007) will return. Arithmetic goes through `getTime()` so a `Date` is never compared with `>=` directly.

9. **Instants are stored as epoch milliseconds; `Date` getters mint a fresh object** _(added after Phase 3 review — Critical)_. `readonly expiresAt: Date` protects the reference, not the value: `hold.expiresAt.setTime(0)` would rewrite the hold's expiry from outside. `Hold`, `Event` and `Order` keep a private `number` and expose `Date` through getters. Arrays (`Event.tiers`, `Order.items`) are copied and frozen for the same reason — `readonly T[]` is a type, and the caller still holds the original array.
10. **`isSafeInteger`, not `isInteger`, in `Money` and `Hold.ttlMs`; `add`/`times` go through `fromCents`** _(review — Major)_. Above 2^53 an "integer" is already rounded, which is the only way integer arithmetic goes wrong in JavaScript; and `ttlMs: 1e300` passed `isInteger` and produced a hold whose expiry was `NaN` — immortal, the exact failure this project warns about with `SET` without `EX`. An invalid `Date` given to `create`, `isExpired` or `remainingMs` throws `InvalidHold` rather than silently reading as "not expired".
11. **`Event.create` rejects a tier whose `eventId` is not the event's** _(review — Major; plan change: adds `errors/InvalidEvent.ts`)_. The model carries both `TicketTier.eventId` and `Event.tiers`; a cross-check is one line and catches exactly the "tier where an event belongs" bug the brands exist for.
12. **All error classes take a message; the message is written at the throw site** _(review — Minor)_. `InvalidMoney(1.5)` thrown from `times` used to say "cents", when 1.5 was the multiplier.

---

## 4. Files

| File                                                             | New / Changed | Why                                             |
| ---------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| `packages/api/src/domain/value-objects/Ids.ts`                   | New           | Branded IDs                                     |
| `packages/api/src/domain/value-objects/HoldToken.ts`             | New           | Branded token                                   |
| `packages/api/src/domain/value-objects/Money.ts`                 | New           | Integer cents                                   |
| `packages/api/src/domain/value-objects/Quantity.ts`              | New           | 1…10                                            |
| `packages/api/src/domain/entities/Event.ts`                      | New           |                                                 |
| `packages/api/src/domain/entities/TicketTier.ts`                 | New           | `canFulfil`                                     |
| `packages/api/src/domain/entities/Hold.ts`                       | New           | `isExpired`, `remainingMs`                      |
| `packages/api/src/domain/entities/Order.ts`                      | New           | `total`, `OrderItem`                            |
| `packages/api/src/domain/errors/DomainError.ts` + six subclasses | New           | `InvalidEvent` added after review (decision 11) |
| `packages/api/test/unit/domain/**/*.test.ts`                     | New           | One test file per source file (§5)              |

No `package.json` change: the domain has no dependencies, by definition.

---

## 5. Test plan

All **unit**, mirroring the source tree under `test/unit/domain/`. No fakes needed — nothing here has a port.

| File                               | Behaviours                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money.test.ts`                    | `fromCents` accepts 0 and 1999; rejects 19.99, −1, `NaN`, `Infinity`; `add` and `times` stay integers (1999 × 3 = 5997, not 5996.999…); `times` rejects 1.5 and −1; `equals` by value; `zero()`                                                            |
| `Quantity.test.ts`                 | accepts 1 and 10; rejects 0, −1, 11, 1.5, `NaN`; `MAX_PER_HOLD` is 10                                                                                                                                                                                      |
| `Ids.test.ts`, `HoldToken.test.ts` | the constructors return the same string (a type-level test: a `TierId` is not assignable to `EventId` — asserted with `@ts-expect-error`, so `tsc` is the test)                                                                                            |
| `TicketTier.test.ts`               | `canFulfil` true when `qty ≤ remaining`, false when `qty > remaining`, false on a sold-out tier for `Quantity.of(1)`; `create` rejects `remaining < 0`, `remaining > total`, `total < 0`                                                                   |
| `Hold.test.ts`                     | expiry is exactly `now + ttlMs`; `isExpired` false at 119 999 ms, **true at 120 000 ms**, true at 120 001 ms; `remainingMs` is 120 000 at creation, 1 at one ms before, 0 at the instant, 0 after (never negative); `create` rejects `ttlMs` of 0, −1, 1.5 |
| `Order.test.ts`                    | `total()` across two tiers (2 × €20 + 1 × €35 = €75 → 7500 cents); single item; `create` rejects an empty item list                                                                                                                                        |
| `Event.test.ts`                    | `create` exposes the given tiers as a readonly array                                                                                                                                                                                                       |
| `DomainError.test.ts`              | every subclass `instanceof DomainError` and `instanceof Error`, with `name` equal to the class name (what the TB-012 handler will log)                                                                                                                     |

**Concurrency:** N/A — pure values, no inventory path (the inventory path is TB-022).

**How each test will be proven able to fail:** flip `>=` to `>` in `isExpired` (the at-boundary test goes red, the other two stay green); drop `Number.isInteger` from `Money.fromCents` (19.99 passes); change `MAX_PER_HOLD` to 11 (the 11 test goes red); make `total()` start from the first item instead of zero (the empty-order test goes red).

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A — no I/O exists in this layer, by construction.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Every function here is pure; calling it twice returns equal values.
- **What if it dies halfway through?** Nothing here is multi-step.

---

## 7. Could Postgres already do this?

N/A — no Redis capability. The inverse holds: the invariants here (`qty ≥ 1`, `price ≥ 0`, `remaining ≤ total`) are _also_ `CHECK` constraints in TB-004's schema. That is deliberate belt-and-braces: the entity stops a bug before a query is written, the constraint stops it if a query bypasses the entity.

---

## 8. Open questions

None blocking. Decision 1 (expired _at_ the boundary) is the one a reviewer might want the other way; it is a one-character change and one test.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed; no Redis/Postgres decision
- ☑ Task doc — `docs/tasks/TB-006-entities-and-value-objects.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
