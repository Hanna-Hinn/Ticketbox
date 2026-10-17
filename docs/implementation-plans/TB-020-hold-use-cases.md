# TB-020 — Hold use cases against in-memory fakes

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-020 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-020-hold-use-cases` (stacked on `spike/TB-019a-cache-invalidation-failures`, which is docs-only on top of `feat/TB-019-stampede-negative-cache-stats`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** finish `CreateHoldUseCase`; add `ReleaseHoldUseCase` and `GetHoldUseCase`. All against `InMemoryHoldStore` and `FakeClock`.

**Acceptance:** the full hold lifecycle is specified in unit tests with no infrastructure.

**Tests:** **unit** — create reduces availability; release restores it; releasing twice restores only once (**idempotency, specified here first**); an expired hold cannot be released; a hold beyond the max quantity is rejected.

**Depends on:** TB-008 — in the stack below this branch (nothing is merged by the session's instruction; every PR is stacked on the previous one): ☑

---

## 2. What I understand this to mean

Before any Redis exists, pin what a hold _does_ over its life — created, read back with its remaining time, released once, gone after its TTL — as use cases that only see ports, with the in-memory store playing the part Redis will play in TB-022 (including the part where an expired hold is simply not there any more, and where nothing has given its inventory back). "Finish `CreateHoldUseCase`" is the open question TB-008 handed over (whole-event lookup vs. a tier lookup), answered below; the use case's behaviour is already specified and does not change.

---

## 3. Approach

### Layers touched

| Layer                                     | What changes                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing — `Hold` already decides expiry (`isExpired`, `remainingMs`)                                                                                           |
| L2 `application/**`                       | `HoldStore` port gains `find(token)`; new `GetHoldUseCase`, `ReleaseHoldUseCase`                                                                               |
| L3 `infrastructure/**`, `presentation/**` | nothing — no route, no adapter (TB-022, TB-023 add them)                                                                                                       |
| L4 `main/**`, `worker/**`                 | nothing — `UnconfiguredHoldStore` in `composition.ts` gains the one method the port now demands (throws, like its siblings)                                    |
| test fakes                                | `InMemoryHoldStore` takes a `Clock`, remembers each hold's expiry, and treats an expired hold as absent — the TTL semantics of the real store, without a Redis |

### The lifecycle, as the use cases will see it

```
CreateHold   reserve(tier, qty, token, ttl)   → { ok, remaining } | insufficient      (unchanged)
GetHold      find(token)                      → Hold | null
               null, or hold.isExpired(now)   → { ok: false, reason: "not-found" }
               else                           → { ok: true, token, tierId, qty, expiresAt, remainingMs: hold.remainingMs(now) }
ReleaseHold  release(token)                   → { released: true, tierId, remaining } | { released: false }   (passed through)
```

### Decisions this plan is making

1. **`CreateHoldUseCase` keeps loading the event through `EventRepository`** (TB-008's open question, closed). The cost TB-008 named — the hottest write runs the most expensive read — is no longer the cost: since TB-018/019 the event read is a cache hit (~1.6 ms single, p50 3–4 ms under load, BENCHMARKS §2) and the live counts come from the store, not the row. Switching to `TicketTierRepository` would add a fake and a Postgres adapter nothing else needs, to save a cache hit. The two distinct failure reasons (`unknown-event`, `unknown-tier`) stay.
2. **The port gains `find(token): Promise<Hold | null>`, returning the entity.** `GET /holds/:token` (TB-025's checkout page) needs the hold back; the port had no read. Returning the entity, not a row-shaped object, matches `EventRepository.findById` and lets the use case ask the entity about time rather than recomputing it.
3. **"Expired" is decided twice, on purpose.** The store (the fake now, Redis later) does not return a hold past its expiry — a Redis key past its TTL answers `nil` on access. The use case _also_ asks `hold.isExpired(now)` and reports `not-found`: the server is the authority on time (handbook §3.2), and the entity, not the adapter, owns the definition. One test uses a stub store that hands back an expired hold to prove the use case does not trust the store on this.
4. **`ReleaseHoldUseCase` is a pass-through to the store's compare-and-restore.** No `find` first — a read followed by a write is the non-atomic sequence this project exists to warn about; the single `release` call is where the decision is made, and its `{ released: false }` is the idempotent second call, the unknown token and the expired hold alike. No clock in this use case: the store decides whether the hold still exists.
5. **An expired hold does not give its inventory back in the fake.** Redis will drop the hold key and leave the tier counter alone; the sweeper (TB-026) reconciles. The fake mirrors exactly that — `release` on an expired hold returns `{ released: false }` _and_ `availability` stays reduced — so the unit tests pin the lesson "expiry is not a release" before any Redis exists. A fake that quietly restored on expiry would hide the whole reason TB-026 exists.
6. **The fake takes a `Clock` as a required constructor argument.** It needs a creation instant to turn `ttlMs` into an expiry (the TB-008 follow-up). Required, not defaulted: a test whose holds can expire should say which clock they expire on. Every existing `new InMemoryHoldStore()` call site passes the clock it already has.
7. **No mirror, no publish.** `HoldRepository.setStatus(token, "released")` is TB-024's; `EventPublisher.availabilityChanged` is the SSE task's. Adding them here with nothing behind them would be speculative.

### New or changed ports

```ts
// application/ports/HoldStore.ts — one method added
/** The live hold, or null once it has expired or never existed. */
find(token: HoldToken): Promise<Hold | null>;
```

Fake: `InMemoryHoldStore(clock: Clock)` — `reserve` builds a `Hold` with `Hold.create({ …, now: clock.now(), ttlMs })`; `find`/`release` treat `hold.isExpired(clock.now())` as absent; `seed` and `availability` unchanged.

### Redis keys

None. (`keys.hold(token)` already exists for TB-022.)

### Lua scripts

None.

### Migrations

None.

---

## 4. Files

| File                                                                        | New / Changed | Why                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/src/application/ports/HoldStore.ts`                           | Changed       | `find(token)`                                                                                                                             |
| `packages/api/src/application/use-cases/GetHold.ts`                         | New           | decision 3                                                                                                                                |
| `packages/api/src/application/use-cases/ReleaseHold.ts`                     | New           | decision 4                                                                                                                                |
| `packages/api/src/infrastructure/system/UnconfiguredHoldStore.ts`           | Changed       | `find` throws like its siblings (the port grew). The plan first named `composition.ts`; the placeholder lives in `infrastructure/system/` |
| `packages/api/test/fakes/InMemoryHoldStore.ts`                              | Changed       | clock, expiry, `find` (decisions 5, 6)                                                                                                    |
| `packages/api/test/unit/application/use-cases/GetHold.test.ts`              | New           |                                                                                                                                           |
| `packages/api/test/unit/application/use-cases/ReleaseHold.test.ts`          | New           |                                                                                                                                           |
| `packages/api/test/unit/fakes/fakes.test.ts`                                | Changed       | the fake's expiry semantics are part of the contract it pins                                                                              |
| `packages/api/test/unit/application/use-cases/CreateHold.test.ts`           | Changed       | the world passes its clock to the store                                                                                                   |
| `packages/api/test/unit/application/use-cases/GetEventAvailability.test.ts` | Changed       | same, one line                                                                                                                            |
| `packages/api/test/integration/http/{health,events,errors}.test.ts`         | Changed       | same, one line each                                                                                                                       |
| `docs/tasks/TB-008-use-cases-and-fakes.md`                                  | Changed       | tick the two follow-ups this task closes                                                                                                  |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                               | What it would catch                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Unit        | `CreateHold`: create reduces availability (exists); a hold beyond `Quantity.MAX_PER_HOLD` is rejected before touching the store (exists)                                                                           | the Tests line                                         |
| Unit        | `ReleaseHold`: release restores the exact quantity and reports the new count; releasing twice restores once (second call `{ released: false }`, availability unchanged); an unknown token is `{ released: false }` | double credit; a release that invents inventory        |
| Unit        | `ReleaseHold`: an expired hold cannot be released — `{ released: false }` **and availability stays reduced** (the sweeper's job, TB-026)                                                                           | a release that treats expiry as a release              |
| Unit        | `ReleaseHold`: a hold released one ms before its expiry restores; at its expiry instant it does not (the boundary is the entity's)                                                                                 | an off-by-one between the entity and the store         |
| Unit        | `GetHold`: returns token, tier, qty, `expiresAt` and `remainingMs` from the injected clock; `remainingMs` shrinks as the clock advances; an unknown token is `not-found`; at the expiry instant it is `not-found`  | a UI counting down from the wrong authority            |
| Unit        | `GetHold`: with a stub store that returns an already-expired hold, the use case still answers `not-found`                                                                                                          | the use case trusting the adapter on time (decision 3) |
| Unit        | `fakes.test`: the store forgets an expired hold without restoring its inventory; `find` returns the live hold and `null` after expiry                                                                              | the fake drifting from the semantics Redis will have   |
| Integration | none — the Scope line is "against in-memory fakes"                                                                                                                                                                 |                                                        |
| Concurrency | none — a single-threaded fake cannot interleave; TB-021 produces the race and TB-022 fixes it against real Redis                                                                                                   |                                                        |
| Smoke / E2E | none                                                                                                                                                                                                               |                                                        |

**Concurrency:** this task touches no real inventory. TB-022's 200-parallel / 10-remaining test is the one.

**How each test will be proven able to fail:** make the fake's `release` ignore expiry (the expired-release tests go red); make `release` restore on the second call (idempotency red); drop `isExpired` from `GetHold` (the stub-store test red); return `0` for `remainingMs` (the countdown tests red); make the fake restore inventory on expiry (decision 5's test red).

---

## 6. Risks and failure modes

- **What if Redis is down?** Not applicable — no Redis in this task. The use cases' failure behaviour is whatever the store throws (a bug) or returns (a value); TB-022 decides what a dead store does.
- **What if a key is evicted under `allkeys-lru`?** Not applicable here; from the use cases' side an evicted hold is indistinguishable from an expired one — `not-found`, `{ released: false }` — which is why `find` returns `null` and not a reason.
- **What if this operation runs twice?** `ReleaseHold` twice restores once — that is the Tests line, specified here first and carried by the store's compare-and-restore. `GetHold` is a read.
- **What if it dies halfway through?** Both new use cases make exactly one call to one port; there is no halfway.

---

## 7. Could Postgres already do this?

No Redis capability is added. The question for holds proper — a `holds` table with `expires_at` and a `WHERE expires_at > now()` — is TB-022's and TB-024's to argue; the mirror ADR (TB-024) is where it gets written down.

---

## 8. Open questions

None blocking. Decision 1 (keep the whole-event lookup) reverses the direction TB-008 leaned; the cache is the reason, and a reviewer may disagree.

What `GET /holds/:token` must carry for the checkout page's order summary (tier name, price, the event) is **not** decided here: the hold is tier-scoped and the use case returns what the hold knows. TB-025 owns that, with two obvious shapes (enrich in `GetHold` through `TicketTierRepository`, or have the UI already know the event it came from).

---

## 9. Documentation this task will produce

- ☐ ADR — none; the decisions above are use-case shape, not architecture. Idempotent release gets its ADR with the Lua in TB-023 if it needs one
- ☑ Task doc — `docs/tasks/TB-020-hold-use-cases.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
