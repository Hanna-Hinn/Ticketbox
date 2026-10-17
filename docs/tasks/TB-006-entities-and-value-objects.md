# TB-006 — Entities and value objects

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-006 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-006-entities-and-value-objects.md`](../implementation-plans/TB-006-entities-and-value-objects.md)
**Branch / PR:** `feat/TB-006-entities-and-value-objects` · [#9](https://github.com/Hanna-Hinn/Ticketbox/pull/9) (based on #8)
**ADR:** none — no Redis/Postgres decision.

---

## What this task delivered

Layer 1 exists. `packages/api/src/domain/` holds the rules of the box office with no import from outside the folder: `Money` that cannot be fractional or negative, `Quantity` that cannot exceed ten, branded IDs the compiler keeps apart, and four immutable entities with the four behaviours the Scope line names. 74 unit tests pin all of it in under a second, with no database and no Docker.

---

## How it works

```
value-objects/   Money.fromCents(1999)      → integer cents, isSafeInteger, ≥ 0; add/times re-validate
                 Quantity.of(2)             → 1 … MAX_PER_HOLD (10)
                 eventId("…") / tierId / orderId / holdToken   → brand casts, no validation (Zod's job)
entities/        TicketTier.canFulfil(qty)  → qty.value ≤ remaining
                 Hold.isExpired(now)        → now ≥ expiresAt   (expired AT the boundary instant)
                 Hold.remainingMs(now)      → max(0, expiresAt − now)
                 Order.total()              → Σ unitPrice × qty, as Money
                 Event.create(…)            → rejects a tier whose eventId is not the event's
errors/          DomainError (abstract, sets name) ← InvalidMoney · InvalidQuantity · InvalidHold · InvalidOrder · InvalidTicketTier · InvalidEvent
```

Three mechanics worth remembering:

- **Instants are epoch milliseconds, not `Date` fields.** `readonly expiresAt: Date` protects the _reference_; `hold.expiresAt.setTime(0)` would still rewrite the expiry. Every entity keeps a private `number` and its `Date` getters mint a fresh object per call. Arrays (`Event.tiers`, `Order.items`) are frozen copies for the same reason.
- **`isSafeInteger`, not `isInteger`.** Above 2^53 an "integer" is already rounded, which is the only way integer arithmetic goes wrong in JavaScript — and `ttlMs: 1e300` passed `isInteger`, produced an expiry of `NaN`, and `NaN >= anything` is `false`: a hold that never expires, the exact failure this project warns about with `SET` without `EX`, reproduced in pure TypeScript.
- **An invalid `Date` is a bug, not "not expired".** `Hold.create`, `isExpired` and `remainingMs` throw `InvalidHold` on `NaN`, because the silent alternative reads as alive forever.

### Layers touched

| Layer          | What changed                  |
| -------------- | ----------------------------- |
| L1 `domain/**` | New: 15 files (see Key files) |
| L2–L4          | None                          |

### Key files

| File                                          | What it does                                                 |
| --------------------------------------------- | ------------------------------------------------------------ |
| `domain/value-objects/Money.ts`               | Integer cents; `fromCents`, `zero`, `add`, `times`, `equals` |
| `domain/value-objects/Quantity.ts`            | 1…10; `MAX_PER_HOLD`                                         |
| `domain/value-objects/Ids.ts`, `HoldToken.ts` | Branded string types and the only casts that create them     |
| `domain/entities/TicketTier.ts`               | `canFulfil`; invariant `0 ≤ remaining ≤ total`               |
| `domain/entities/Hold.ts`                     | `isExpired`, `remainingMs`; ms-based instants                |
| `domain/entities/Order.ts`                    | `total`; `OrderItem`; non-empty items                        |
| `domain/entities/Event.ts`                    | Frozen tiers; tier-ownership invariant                       |
| `domain/errors/*.ts`                          | `DomainError` and six one-line subclasses                    |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                        | What actually happened                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Entities are immutable: every field `readonly`"                               | **Not enough.** `readonly createdAt: Date` was mutable through `setTime()`, and `readonly tiers: readonly TicketTier[]` still aliased the caller's array. The first commit even defensively copied `now` in `Hold.create` and then exposed the copy mutably. Fixed with private ms + getters, and frozen array copies. | The Phase 3 review's two Criticals. `readonly` in TypeScript is a type-level promise about reassignment, not about the object behind the reference.                                                              |
| `Number.isInteger` for `Money` and `ttlMs`                                     | `isSafeInteger`; `add`/`times` route through `fromCents`; the computed expiry is checked to be a representable `Date`.                                                                                                                                                                                                 | Review Majors 1–2: `1e300` is an "integer" and makes an immortal hold; `MAX_SAFE_INTEGER + 2` is an "integer" and is already rounded.                                                                            |
| `Event.create` with no invariant                                               | Rejects a tier whose `eventId` is not the event's; new `errors/InvalidEvent.ts`.                                                                                                                                                                                                                                       | Review Major 4: the plan said every `create` checks invariants, and this is exactly the "tier where an event belongs" bug the brands exist for. Recorded as a plan change (decision 11).                         |
| `InvalidMoney(value)` / `InvalidQuantity(value, max)` built their own messages | All six errors take a `message`; the message is written at the throw site.                                                                                                                                                                                                                                             | Review Minor: `times(1.5)` said "cents" when 1.5 was the multiplier.                                                                                                                                             |
| `isExpired(invalidDate)` unspecified                                           | Throws `InvalidHold`.                                                                                                                                                                                                                                                                                                  | Pinned deliberately rather than left to `NaN` comparison semantics. A clock that cannot tell the time is a bug.                                                                                                  |
| —                                                                              | **Deliberately not done:** `Event.create({ startsAt: new Date("garbage") })` and `Order.create({ createdAt: new Date(NaN) })` do not throw; the `NaN` round-trips through the getter.                                                                                                                                  | Nothing reads those fields yet. `Hold` guards because a `NaN` expiry has a consequence. TB-010 (reads `startsAt`) and TB-024 (persists `createdAt`) should add the guard when they start depending on the value. |

---

## 4. Tests shipped

| Level | Test file                                         | Behaviour asserted                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit  | `test/unit/domain/value-objects/Money.test.ts`    | accepts 0/1999; rejects 19.99, −1, NaN, ∞, MAX_SAFE+2; 1999 × 3 = 5997; add; `times` rejects 1.5/−1/NaN naming the multiplier; add/times past 2^53 throw; equals by value; operands untouched                                                                                                                      |
| Unit  | `test/unit/domain/value-objects/Quantity.test.ts` | MAX is 10; accepts 1/5/10; rejects 0, −1, 11, 1.5, NaN                                                                                                                                                                                                                                                             |
| Unit  | `test/unit/domain/value-objects/Ids.test.ts`      | constructors return the string unchanged; `TierId` → `EventId` is a compile error (`@ts-expect-error`, so `tsc` is the test)                                                                                                                                                                                       |
| Unit  | `test/unit/domain/entities/TicketTier.test.ts`    | `canFulfil` below / at / above remaining; sold-out refuses 1; rejects negative/fractional remaining, remaining > total, negative total                                                                                                                                                                             |
| Unit  | `test/unit/domain/entities/Hold.test.ts`          | expiry = now + ttl; alive at 119 999, **expired at 120 000**, expired at 120 001; `remainingMs` 120000/1/0/0; `remainingMs === 0 ⇔ isExpired`; rejects ttl 0/−1/1.5/NaN/1e300/9e15 and an invalid `now`; invalid clock reading throws; expiry not rewritable via the handed-out `Date`; caller's `now` not aliased |
| Unit  | `test/unit/domain/entities/Order.test.ts`         | single-line total; 2 × €20 + 1 × €35 = €75; empty items rejected; caller's array mutation ignored; items frozen; `createdAt` not aliased or rewritable                                                                                                                                                             |
| Unit  | `test/unit/domain/entities/Event.test.ts`         | tiers frozen copy; empty tiers accepted; foreign tier rejected; `startsAt` not aliased or rewritable                                                                                                                                                                                                               |
| Unit  | `test/unit/domain/errors/DomainError.test.ts`     | each subclass: `instanceof DomainError`/`Error`, `constructor` is the class, `name` is the class name, message preserved                                                                                                                                                                                           |

74 tests, 10 files (incl. TB-001/003's), 972 ms.

**Proven able to fail** — five sabotages, each reverted, suite green after:

```
SABOTAGE 1: isExpired uses > instead of >=
  × is expired at exactly its expiry instant
  × agrees with itself: zero remaining if and only if expired
  Tests  2 failed | 72 passed (74)

SABOTAGE 2: Money.fromCents uses isInteger and drops the < 0 check
  × rejects -1 as cents
  × rejects 9007199254740992 as cents
  × refuses to add past the safe-integer ceiling instead of silently rounding
  × refuses to multiply past the safe-integer ceiling instead of silently rounding
  Tests  4 failed | 70 passed (74)

SABOTAGE 3: MAX_PER_HOLD = 11
  × caps a single hold at 10 tickets
  × rejects 11
  Tests  2 failed | 72 passed (74)

SABOTAGE 4: Order.items / Event.tiers store the caller's array directly
  × is unaffected by the caller mutating the array it was built from
  × exposes its items as a frozen array
  × exposes its tiers as a frozen copy
  Tests  3 failed | 71 passed (74)

SABOTAGE 5: Hold hands out a stored Date object instead of a fresh one
  × cannot have its expiry rewritten through the Date it hands out
  Tests  1 failed | 73 passed (74)
```

**Coverage after this task** (`vitest --coverage`, v8): `domain/**` **100 %** statements, branches, functions and lines, every file. `application/**` does not exist yet. `infrastructure/**` reads 0 % under the _unit_ runner because `migrations.ts`/`seed.ts` are only exercised by the integration suite — which is why the global threshold is not enforced in CI yet (TB-042).

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool
**Verdict:** NEEDS WORK → fixed → re-reviewed (the reviewer ran 24 behavioural checks against the fixed code itself, including trying to mutate the entities) → **SAFE TO MERGE**

| Finding                                                                          | Severity | Resolution                                                                    |
| -------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `Hold.expiresAt`/`createdAt` mutable via `setTime()` despite `readonly`          | Critical | Private ms + `Date` getters                                                   |
| `Event.startsAt`, `Order.createdAt` stored the caller's `Date` (not even copied) | Critical | Same                                                                          |
| `ttlMs: 1e300` or an invalid `now` → `NaN` expiry → immortal hold                | Major    | `isSafeInteger`; representable-date check; `instant()` helper throws on `NaN` |
| `Money` "never floats" was `isInteger`; `add`/`times` bypassed validation        | Major    | `isSafeInteger`; both route through `fromCents`                               |
| `readonly T[]` aliased the caller's array                                        | Major    | `Object.freeze([...props.x])`                                                 |
| `Event.create` checked no invariant though the plan said every `create` does     | Major    | Tier-ownership check + `InvalidEvent` (plan change recorded)                  |
| `InvalidMoney` message said "cents" when thrown for a multiplier                 | Minor    | Messages at throw sites; all errors take a message                            |
| Plan §4 still said "five subclasses" after the fix commit                        | Minor    | Fixed in Phase 5                                                              |
| `Event.startsAt` / `Order.createdAt` accept an invalid `Date`                    | Noted    | Deliberately not guarded; see §3                                              |

Findings deliberately **not** fixed: the last row.

---

## 6. Failure modes, as built

- **Redis down / key evicted:** N/A — no I/O in this layer, by construction.
- **Operation runs twice:** every function is pure; the same inputs give equal outputs. Tested indirectly everywhere.
- **Dies halfway through:** nothing here is multi-step.
- **The one failure mode this layer _owns_: an immortal hold.** A `NaN` expiry, a rewritable `expiresAt`, or an unsafe-integer `ttlMs` would each produce a hold that reads as alive forever. All three are now thrown or impossible, and each has a test that went red when the guard was removed.

---

## 7. What I'd do differently

Treat `readonly` with the suspicion it deserves before claiming immutability. The plan said "every field `readonly`" as if that settled it; the reviewer broke the entity with one `setTime()` call. For a project whose core concept is a deadline, the deadline being rewritable from outside was the worst possible first bug.

---

## 8. Follow-ups left behind

- [ ] TB-010 / TB-024: when `Event.startsAt` or `Order.createdAt` are first read or persisted, decide whether to guard an invalid `Date` the way `Hold` does.
- [ ] TB-024: `Hold` can only be built from `(now, ttlMs)`; rehydrating from a stored row means `ttlMs = expires_at − created_at`, so the mirror must persist `created_at` (TB-004's schema does).
- [ ] TB-008: test data builders (`aTier().withRemaining(10).build()`) — the small `tierWith`/`aHold`/`anOrder` helpers in these test files are the seed of them.
