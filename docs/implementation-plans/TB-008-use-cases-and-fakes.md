# TB-008 — First use cases plus in-memory fakes

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-008 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-008-use-cases-and-fakes` (stacked on `feat/TB-007-ports`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `GetEventAvailabilityUseCase` and `CreateHoldUseCase`. In `test/fakes/`: `InMemoryHoldStore`, `InMemoryEventRepository`, `FakeClock` (with `advance(ms)`), `FixedTokenGenerator`. Test data builders (`aTier().withRemaining(10).build()`).

**Acceptance:** `CreateHoldUseCase` runs green with zero infrastructure. `pnpm test:unit` finishes in under 2 seconds.

**Tests:** **unit** — creates a hold when inventory allows; rejects when `qty > remaining`; rejects a nonexistent tier; hold expiry is exactly `now + ttl` using `FakeClock`; two sequential holds reduce availability correctly.

**Depends on:** TB-007 (open, PR #10 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

The first proof that the architecture works: two Layer 2 classes, one public `execute` each, talking only to the TB-007 ports, and running green against hand-written in-memory implementations of those ports with no database anywhere. The fakes and builders are test infrastructure that every later unit test will reuse, so their shape matters almost as much as the use cases'.

"Two sequential holds reduce availability correctly" is the sentence that fixes the design: it means `GetEventAvailabilityUseCase` must reflect holds made through `CreateHoldUseCase`, i.e. both go through the same `HoldStore`.

---

## 3. Approach

### Layers touched

| Layer                       | What changes                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`              | None                                                                                                   |
| L2 `application/use-cases/` | New: `CreateHold.ts`, `GetEventAvailability.ts`                                                        |
| L3–L4                       | None                                                                                                   |
| `test/fakes/`               | New: `InMemoryHoldStore`, `InMemoryEventRepository`, `FakeClock`, `FixedTokenGenerator`, `builders.ts` |

### The use cases

```
CreateHoldUseCase(events: EventRepository, holds: HoldStore, clock: Clock, tokens: TokenGenerator, holdTtlMs: number)
  execute({ eventId, tierId, qty })
    qty      → Quantity.of(qty)                           throws InvalidQuantity (a bug past the Zod boundary)
    event    → events.findById(eventId)                   null → { ok: false, reason: "unknown-event" }
    tier     → event.tiers.find(id === tierId)            none → { ok: false, reason: "unknown-tier" }
    token    → tokens.next();  now → clock.now()
    reserved → holds.reserve(tierId, qty, token, ttlMs)   !ok  → { ok: false, reason: "insufficient" }
    hold     → Hold.create({ token, tierId, qty, now, ttlMs })
    → { ok: true, token, expiresAt: hold.expiresAt, remaining: reserved.remaining }

GetEventAvailabilityUseCase(events: EventRepository, holds: HoldStore)
  execute({ eventId })
    event → events.findById(eventId)                       null → { ok: false, reason: "unknown-event" }
    live  → holds.availability(event.tiers.map(id))
    → { ok: true, event: { id, name, venue, startsAt, tiers: [{ id, name, priceCents, total, remaining: live.get(id) ?? tier.remaining }] } }
```

### The fakes

| Fake                      | Implements        | Behaviour                                                                                                                                                               |
| ------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InMemoryEventRepository` | `EventRepository` | `constructor(events)`; `findById`; `listUpcoming(now)` = `startsAt > now`                                                                                               |
| `InMemoryHoldStore`       | `HoldStore`       | `seed(tierId, remaining)`; `reserve` decrements or returns `insufficient` (unknown tier counts as insufficient); `release` restores once; `availability` of known tiers |
| `FakeClock`               | `Clock`           | `constructor(iso)`; `now()` returns a fresh `Date`; `advance(ms)`                                                                                                       |
| `FixedTokenGenerator`     | `TokenGenerator`  | `constructor(tokens)`; `next()` hands them out in order and throws when exhausted — a test that creates more holds than it planned for should fail loudly               |
| `builders.ts`             | —                 | `aTier()`, `anEvent()` with `with…()` setters and `build()`; sensible defaults (10 remaining of 100, €20)                                                               |

### Decisions this plan is making

1. **`CreateHoldUseCase` looks the tier up through `EventRepository`, not `TicketTierRepository`.** The honest reason: the Scope line's fake list names four fakes and no `InMemoryTicketTierRepository`, and this task builds exactly those four. The request carries `eventId` (handbook §2.5), so loading the event and finding the tier in it gives the "tier belongs to this event" check with two distinct reasons (`unknown-event`, `unknown-tier`). **The cost, stated plainly** _(review)_: every `POST /holds` loads the whole event with `remaining` computed for _every_ tier — the TB-010 `total − sold − active holds` query, the one TB-013 benchmarks — to do a membership check that `TicketTierRepository.findById(tierId)` + `tier.eventId !== input.eventId` could do with one row. The hottest write runs the most expensive read. **Handed to TB-020 ("finish `CreateHoldUseCase`") as an open question**, not settled here.
2. **`GetEventAvailabilityUseCase` prefers the live count and falls back to the repository's computed one** (`live.get(id) ?? tier.remaining`). This is the central "which source wins" question of the repo, so it is an ADR, not a plan note: [`docs/adr/0002-live-count-wins-computed-count-is-the-fallback.md`](../adr/0002-live-count-wins-computed-count-is-the-fallback.md) _(written after the Phase 3 review said "not needed" was the wrong answer)_. The ADR admits what this hides: the use case cannot tell "never seeded" from "lost the key", and after an eviction reads and writes can disagree silently. TB-022/TB-027 own who seeds the counter; TB-039 must revisit whether the fallback stays silent.
3. **The hold TTL is a constructor parameter, not a constant.** TB-028a needs "a test-only short TTL via config", and the test "expiry is exactly `now + ttl`" needs a known value. Nothing else is configurable.
4. **No `canFulfil` pre-check in `CreateHold`.** The repository's `remaining` is a snapshot; the atomic decision is `holds.reserve`. Checking twice would create two answers to one question, and the stale one would win on the Redis path. `TicketTier.canFulfil` keeps its caller in the UI-facing "sold out" decision (TB-011's mapper) and the sweeper (TB-026).
5. **No `HoldRepository` and no `EventPublisher` in `CreateHold` yet.** TB-024 adds the mirror write; TB-037 adds the publish. Each adds its own fake then. The Scope line's fake list is exactly the four this plan builds.
6. **Use cases return plain data, not entities.** `GetEventAvailability` returns a readonly structure with `priceCents` as a number; TB-011's controller maps it to the response DTO without touching a `Money`. "Only simple data crosses boundaries" applied to the L2→L3 boundary as well.
7. **Fakes live in `test/fakes/`, builders in `test/fakes/builders.ts`.** The handbook's folder structure lists `test/fakes/`; a new top-level `test/builders/` would be inventing a directory.
8. **`FixedTokenGenerator` takes a list.** A single fixed token would make the second of "two sequential holds" overwrite the first in any token-keyed store. The fake store also _throws_ on a duplicate token _(review)_: silently overwriting would leak the first hold's quantity, which is exactly the class of bug a fake exists to make loud.
9. **Where the throw/return line sits, stated once** _(review)_: value-object invariants (`Quantity.of(11)`) throw a `DomainError` that TB-012's single handler maps; lookups and inventory outcomes (`unknown-event`, `unknown-tier`, `insufficient`) are return values. `Quantity.of` runs before any I/O. Consequences for later tasks: TB-011's Zod schema must take its upper bound from `Quantity.MAX_PER_HOLD`, not a literal, or the limit lives in two places; TB-020's "a hold beyond the max quantity is rejected" asserts `rejects.toThrow(InvalidQuantity)`; TB-012's "a thrown `TierNotFound` yields 404" is whatever the controller maps `unknown-tier` to, not a throw from L2.
10. **`Hold.create` runs before `holds.reserve`** _(review — Critical)_. The entity is where `ttlMs` and the clock reading are validated; the first draft built it _after_ the reserve, so a misconfigured TTL (TB-028a's test-only short TTL comes from config) would have decremented inventory and then thrown with no token to release. Every input the entity needs exists before the reserve, so the fix was a reorder. The clock is also read before the reserve on purpose: the expiry the client is told must be no later than the store's real one.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File                                                                        | New / Changed |
| --------------------------------------------------------------------------- | ------------- |
| `packages/api/src/application/use-cases/CreateHold.ts`                      | New           |
| `packages/api/src/application/use-cases/GetEventAvailability.ts`            | New           |
| `packages/api/test/fakes/InMemoryEventRepository.ts`                        | New           |
| `packages/api/test/fakes/InMemoryHoldStore.ts`                              | New           |
| `packages/api/test/fakes/FakeClock.ts`                                      | New           |
| `packages/api/test/fakes/FixedTokenGenerator.ts`                            | New           |
| `packages/api/test/fakes/builders.ts`                                       | New           |
| `packages/api/test/unit/application/use-cases/CreateHold.test.ts`           | New           |
| `packages/api/test/unit/application/use-cases/GetEventAvailability.test.ts` | New           |

---

## 5. Test plan

All **unit**, every port faked, no Docker.

| Test                                                                  | What it would catch                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| creates a hold when inventory allows (token, expiresAt, remaining)    | the happy path wired wrong                                    |
| rejects when `qty > remaining` with `insufficient`, store untouched   | a decrement before the decision                               |
| rejects a nonexistent event / a tier not on that event                | the lookup, and a tier id from another event sneaking through |
| hold expiry is exactly `now + ttl` from `FakeClock`                   | `Date.now()` sneaking in, or an off-by-one                    |
| two sequential holds reduce availability by both quantities           | the two use cases disagreeing about which store is the truth  |
| a hold for exactly the remaining count succeeds and leaves 0          | an off-by-one in the comparison                               |
| `GetEventAvailability` returns the computed count for an unknown tier | the fallback (decision 2)                                     |
| `GetEventAvailability` for an unknown event returns `unknown-event`   | a null dereference                                            |
| `pnpm test:unit` completes in under 2 s                               | the Acceptance line (observed in the run output)              |

**Concurrency:** N/A — the in-memory store is single-threaded; the concurrency test belongs to the real store (TB-022).

**How each test will be proven able to fail:** make `reserve` decrement before checking; return `tier.remaining` instead of the live count; use `new Date()` instead of `clock.now()`; drop the event-membership check.

---

## 6. Risks and failure modes

- **What if Redis is down?** Not reachable here; the store is in memory. The use case lets a throwing store throw (bugs are exceptions) — TB-039 decides the policy.
- **What if a key is evicted under `allkeys-lru`?** Decision 2's fallback means the read path shows the computed count; the write path returns `insufficient` for an unknown tier (the fake's behaviour; TB-022 decides the real one, TB-007 decision 11).
- **What if this operation runs twice?** Two `CreateHold` calls are two holds — that is correct, not a problem. `GetEventAvailability` is read-only.
- **What if it dies halfway through?** Between `reserve` and the return there is only `Hold.create`, which is pure. Once TB-024 adds the mirror write, that gap becomes real and TB-024's plan owns it.

---

## 7. Could Postgres already do this?

N/A — no Redis capability. The `HoldStore` fake is the stand-in for one, and decision 2 is the honest version of the question: the Postgres computation _is_ the fallback.

---

## 8. Open questions

None blocking. For TB-012: what `HoldStore` does the composition root pass before TB-022 exists? Decision 2 makes an "empty" store correct for reads, but something must satisfy the constructor. Not this task's question; flagged.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0002-live-count-wins-computed-count-is-the-fallback.md` (added after review)
- ☑ Task doc — `docs/tasks/TB-008-use-cases-and-fakes.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
