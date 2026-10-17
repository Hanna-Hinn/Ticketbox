# TB-008 — First use cases plus in-memory fakes

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-008 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-008-use-cases-and-fakes.md`](../implementation-plans/TB-008-use-cases-and-fakes.md)
**Branch / PR:** `feat/TB-008-use-cases-and-fakes` · [#11](https://github.com/Hanna-Hinn/Ticketbox/pull/11) (based on #10)
**ADR:** [`docs/adr/0002-live-count-wins-computed-count-is-the-fallback.md`](../adr/0002-live-count-wins-computed-count-is-the-fallback.md)

---

## What this task delivered

The architecture works. `CreateHoldUseCase` and `GetEventAvailabilityUseCase` run green against four hand-written in-memory ports with no database, no Docker and no network, and the whole unit suite (95 tests) finishes in about a second of test time. The fakes and the `aTier()` / `anEvent()` builders under `test/fakes/` are now what every later unit test is written against.

---

## How it works

```
CreateHoldUseCase.execute({ eventId, tierId, qty })
  Quantity.of(qty)                       throws InvalidQuantity       ← before any I/O
  events.findById(eventId)               null → { ok: false, reason: "unknown-event" }
  event.tiers.find(tierId)               none → { ok: false, reason: "unknown-tier" }
  tokens.next(); clock.now()
  Hold.create({ token, tierId, qty, now, ttlMs })   throws InvalidHold ← BEFORE the reserve
  holds.reserve(tierId, qty, token, ttlMs)          !ok → { ok: false, reason: "insufficient" }
  → { ok: true, token, expiresAt, remaining }

GetEventAvailabilityUseCase.execute({ eventId })
  events.findById(eventId)               null → { ok: false, reason: "unknown-event" }
  holds.availability(tierIds)
  → tiers with remaining = live.get(id) ?? tier.remaining            ← ADR 0002
```

The ordering in `CreateHold` is the whole lesson of this task's review. `Hold.create` is where the TTL and the clock reading are validated; if it ran after `reserve`, a bad TTL from config would decrement inventory and then throw with no token anyone could release. The clock is read before the reserve too, so the expiry the client sees is never later than the store's.

### Layers touched

| Layer                       | What changed                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`              | None                                                                                                   |
| L2 `application/use-cases/` | New: `CreateHold.ts`, `GetEventAvailability.ts`                                                        |
| L3–L4                       | None                                                                                                   |
| `test/fakes/`               | New: `InMemoryHoldStore`, `InMemoryEventRepository`, `FakeClock`, `FixedTokenGenerator`, `builders.ts` |

### Key files

| File                                                | What it does                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `application/use-cases/CreateHold.ts`               | The sequence above; TTL injected via the constructor                                         |
| `application/use-cases/GetEventAvailability.ts`     | Event + live counts → plain readonly data                                                    |
| `test/fakes/InMemoryHoldStore.ts`                   | Counter per tier, record per token; `seed()`; throws on a duplicate token                    |
| `test/fakes/InMemoryEventRepository.ts`             | `findById`, `listUpcoming` (strict `>`)                                                      |
| `test/fakes/FakeClock.ts`, `FixedTokenGenerator.ts` | `advance(ms)`; tokens in order, throws when exhausted                                        |
| `test/fakes/builders.ts`                            | `aTier().withId().forEvent().withRemaining()`, `anEvent().withId().startingAt().withTiers()` |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                                                    | What actually happened                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 sequence: reserve, _then_ `Hold.create`; §6: "only `Hold.create`, which is pure" sits after the reserve | **Reordered.** Pure is not the same as non-throwing: `Hold.create` validates `ttlMs` and the clock, so a misconfigured TTL reserved inventory and then threw. Every input the entity needs exists before the reserve, so the fix was three lines moved up.                                                                                    | Phase 3 review, Critical. §6's "dies halfway through" answer is now literally true: nothing sits between the reserve and the return.                                             |
| Decision 2's fallback: "ADR — not needed"                                                                  | ADR 0002 written. It also admits the eviction case the fallback hides: after a lost key, reads show the computed count while `reserve` answers whatever TB-022 decides, and nothing logs the disagreement.                                                                                                                                    | Review, Major: "which source wins" is the central decision of this repo.                                                                                                         |
| Decision 1 justified by "one class cannot implement both ports"                                            | Justification rewritten: the real reason is the Scope line's fake list. The real cost stated: every `POST /holds` loads the whole event with availability computed for every tier to do a one-row membership check. **Handed to TB-020 as an open question.**                                                                                 | Review, Major: the hottest write runs the most expensive read, and the plan understated it.                                                                                      |
| `InMemoryHoldStore` recorded `ttlMs` per hold                                                              | Dropped. Without a creation instant a TTL cannot yield an expiry; when TB-020 needs "an expired hold cannot be released" the fake needs a clock, which is a different design.                                                                                                                                                                 | Review, Minor: dead data.                                                                                                                                                        |
| Builders with `withName`, `withPriceCents`, `withTotal` on tiers                                           | Removed; only the setters Phase 4 calls remain. `forEvent` takes a plain string like every other id setter.                                                                                                                                                                                                                                   | Review, Minor.                                                                                                                                                                   |
| "`pnpm test:unit` finishes in under 2 seconds"                                                             | **Depends on what is measured.** vitest reports `Duration 1.07s` for the suite. `pnpm test:unit` from the repo root is **3.0 s wall clock** in this container (three runs: 3.06, 3.21, 3.03), of which roughly 2 s is pnpm's workspace fan-out and Node startup — `pnpm exec vitest run` directly is 2.4 s. The tests themselves take 156 ms. | The Acceptance line names the pnpm command; the handbook's intent ("the whole suite under 2 seconds") is about the tests. Both numbers recorded; neither is quoted as the other. |

---

## 4. Tests shipped

| Level | Test file                                                      | Behaviour asserted                                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit  | `test/unit/application/use-cases/CreateHold.test.ts`           | creates a hold (token, expiry, remaining); expiry exactly `now + ttl` from `FakeClock`; `qty > remaining` → `insufficient`, store untouched; exactly-remaining leaves 0; unknown event; tier not on event; two sequential holds → 8 then 5; `qty` 0/11 throws `InvalidQuantity` before any I/O; **ttl 0 and an unreadable clock throw without reserving** |
| Unit  | `test/unit/application/use-cases/GetEventAvailability.test.ts` | plain-data shape; live `0` is shown as `0` (`??` not `\|\|`); fallback only for tiers the store has never seen; unknown event is a value                                                                                                                                                                                                                  |
| Unit  | `test/unit/fakes/fakes.test.ts`                                | unseeded tier is `insufficient` and not invented; release restores once, second returns `{ released: false }`; duplicate token throws and does not decrement; `FixedTokenGenerator` throws when exhausted; `FakeClock` advances and hands out fresh dates; `listUpcoming` is strict `>`                                                                   |

95 tests, 13 files; vitest `Duration 1.07s`.

**Proven able to fail** — five sabotages, each reverted, suite green after:

```
SABOTAGE 1: Hold.create moved back after reserve
  × rejects a misconfigured ttl without reserving anything
  × rejects an unreadable clock without reserving anything
  Tests  2 failed | 93 passed (95)

SABOTAGE 2: ?? becomes || in GetEventAvailability
  × shows the live count for a tier the store knows, including zero
  Tests  1 failed | 94 passed (95)

SABOTAGE 3: clock.now() replaced by new Date()
  × creates a hold when inventory allows
  × sets the expiry to exactly now + ttl from the injected clock
  × rejects an unreadable clock without reserving anything
  Tests  3 failed | 92 passed (95)

SABOTAGE 4: fake reserve decrements before checking
  × rejects a hold larger than remaining inventory and leaves it untouched
  × treats a tier it has never seen as insufficient and does not invent it
  Tests  2 failed | 93 passed (95)

SABOTAGE 5: event-membership lookup dropped
  × rejects a nonexistent event
  × rejects a tier that is not on the event
  Tests  2 failed | 93 passed (95)
```

**Coverage after this task** (v8): `domain/**` **100 %**, `application/**` **100 %** (statements, branches, functions, lines; every file). `infrastructure/**` is only exercised by the integration suite.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool
**Verdict:** NEEDS WORK → fixed → re-reviewed (the reviewer wrote and ran its own throwaway test for ttl-0 and the unreadable clock against the fixed code) → **SAFE TO MERGE**

| Finding                                                                                                  | Severity | Resolution                                                                        |
| -------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `Hold.create` after `reserve`: a bad TTL or clock reserves inventory then throws, nothing can release it | Critical | Reordered; "why" comments on both the clock read and the entity build             |
| Fallback (`live ?? computed`) recorded as "ADR not needed"                                               | Major    | ADR 0002, including the eviction disagreement it hides                            |
| Decision 1's justification wrong, its cost understated                                                   | Major    | Rewritten; handed to TB-020 as an open question                                   |
| Throw/return split drawn differently by the plan, TB-020 and TB-012                                      | Major    | Plan decision 9 states it once, with consequences for TB-011/012/020              |
| Fake stored a `ttlMs` nothing could use                                                                  | Minor    | Dropped                                                                           |
| Fake silently overwrote a duplicate token, leaking the first hold                                        | Minor    | Throws                                                                            |
| Builder setters without a caller; `forEvent(EventId)` inconsistent with other id setters                 | Minor    | Removed / takes a string                                                          |
| ADR said the fallback "never over-reports"                                                               | Minor    | Corrected: it over-reports by exactly the holds whose mirror write has not landed |
| Acceptance timing: vitest's 1 s is not pnpm's 3 s                                                        | Minor    | Both recorded in §3                                                               |

Findings deliberately **not** fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** not reachable here. A throwing store propagates (bugs are exceptions); TB-039 sets the policy. The read path's _missing-entry_ case is already handled by the fallback (ADR 0002).
- **Key evicted under `allkeys-lru`:** reads show the computed count; writes get `insufficient` from the fake (TB-022 decides the real store's answer). The disagreement is silent — admitted in ADR 0002, observed in TB-040.
- **Operation runs twice:** two `CreateHold` calls are two holds, correctly. `GetEventAvailability` is read-only. Tested: two sequential holds.
- **Dies halfway through:** nothing sits between `reserve` and the return any more. Tested: ttl-0 and an unreadable clock leave the store untouched. Once TB-024 adds the mirror write after the reserve, that gap is real and TB-024's ADR owns it.

---

## 7. What I'd do differently

Ask "which line can throw?" about every step after the first side effect, not "which line is pure?". The plan's §6 said `Hold.create` was pure and therefore safe to run after the reserve; it was pure _and_ the only validator of the TTL. The reviewer found it by reading the entity, which is where I should have looked.

---

## 8. Follow-ups left behind

- [x] TB-020: decide whether `CreateHold` keeps loading the whole event or switches to `TicketTierRepository.findById` + `tier.eventId` check (plan decision 1).
- [ ] TB-011: the Zod `qty` schema must use `Quantity.MAX_PER_HOLD`, not a literal (plan decision 9).
- [ ] TB-012: something must satisfy `GetEventAvailabilityUseCase`'s `HoldStore` constructor parameter before TB-022 exists (plan §8).
- [ ] TB-022 / TB-027: who seeds the live counter, and what `reserve` returns on a missing key; TB-039: whether the read-path fallback stays silent (ADR 0002).
- [x] TB-020: `InMemoryHoldStore` has no notion of expiry; "an expired hold cannot be released" needs the fake to take a clock.
