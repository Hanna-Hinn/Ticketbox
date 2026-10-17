# TB-025 — Hold UI with countdown

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-025 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-025-hold-ui-countdown.md`](../implementation-plans/TB-025-hold-ui-countdown.md)
**Branch / PR:** `feat/TB-025-hold-ui-countdown` · [#29](https://github.com/Hanna-Hinn/Ticketbox/pull/29) (based on #28)
**ADR:** none new — one line added to [`docs/adr/0002-live-count-wins-computed-count-is-the-fallback.md`](../adr/0002-live-count-wins-computed-count-is-the-fallback.md) for the seed as the counter's first writer

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

The write path reaches the browser. A quantity and a "Get tickets" button on every tier post to `POST /holds`; the checkout page at `/checkout/:token` shows a countdown, an order summary and a "Release" button; at zero it asks the server what happened rather than deciding. Behind that: `POST /holds` and `GET /holds/:token`, the token generator and `HOLD_TTL_MS` the composition root was missing, the `Hold` entity knowing its event, and `pnpm seed` writing the live counters so that a click on a seeded stack creates a real hold.

---

## How it works

```
browser   POST /holds {eventId, tierId, qty}
API       CreateHold: findById → Hold.create(now, ttl) → reserve (Lua) → save (row) → 201 {token, …, expiresAt, remaining}
browser   navigate /checkout/:token
          GET /holds/:token   → 200 {…, remainingMs}       GetHold: find → isExpired(now)? not-found : the hold
          Countdown(remainingMs): deadline = Date.now() + remainingMs, tick every 1 s, at 0 clear the interval, ask once
          GET /holds/:token   → 200 (alive: remount, count from the new remainingMs) | 404 (gone: "This hold has expired")
          DELETE /holds/:token → navigate back to the event; the number is back
```

**The countdown measures elapsed time, never distance to an instant.** The first version counted down to the server's `expiresAt` with the browser's `Date.now()`. A browser clock ahead of the server read zero at once, re-fetched, was told "alive", computed zero again and re-fetched — 190 requests in 3 seconds, reproduced by the reviewer. The browser cannot know the server's instant, but it can measure how long ago the server's answer arrived, and `remainingMs` is the server's own count. So the component anchors `Date.now() + remainingMs` once, on mount, and the only thing the browser's clock contributes is the elapsed time since. A clock that _jumps_ mid-page still reads as expiry once — elapsed time is all the page can measure — and the remount anchors on the clock the page now has, so there is no second question. The E2E proves exactly that: one read, then silence.

**The server is the authority on time, twice.** `GetHold` reads the clock after the lookup and answers 404 for a hold whose instant has passed even if Redis has not yet dropped the key; `remainingMs` is computed server-side from that same reading. The browser never compares two instants.

**The seed opens Redis first.** `pnpm seed` writes rows and then `HSETNX tier:<id> remaining total_qty` for every seeded tier. It connects to Redis before Postgres, with an error listener, so a Redis that is down fails the seed before a row exists and names the cause; opened the other way round, the failure left rows without counters, which is exactly the half-seeded system the plan said it would avoid.

**The quantity bound is one rule.** `Quantity.MAX_PER_HOLD` is referenced by the request schema (`z.int().min(1).max(Quantity.MAX_PER_HOLD)`) rather than copied; a quantity outside it is a 400 like any malformed field, and the entity's own `InvalidQuantity` is an invariant again, unmapped, a 500 if a route ever lets one through.

### Layers touched

| Layer                                     | What changed                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | `Hold` gains `eventId`; `errors/InsufficientInventory`, `errors/HoldNotFound` (new)                                                                                                                                                                                                                |
| L2 `application/**`                       | `CreateHold` returns `eventId`, `tierId`, `qty`; `GetHold` returns `eventId`                                                                                                                                                                                                                       |
| L3 `infrastructure/**`, `presentation/**` | `create_hold.lua` + `RedisHoldStore` store and read `eventId`; `redis/seedLiveCounters.ts` (new); `system/UuidTokenGenerator.ts` (new); `dto/holds.ts` (request, created, hold, release); `HoldController` takes all three use cases; `routes/holds.ts` POST/GET/DELETE; `http/errors.ts` two rows |
| L4 `main/**`                              | `config.ts`: `HOLD_TTL_MS`; `composition.ts`: `CreateHoldUseCase`, `GetHoldUseCase`, `UuidTokenGenerator`; `seed.ts`: Redis first, then rows, then counters                                                                                                                                        |
| web                                       | `api/client.ts`: `createHold`, `getHold`, `releaseHold`; `components/Countdown.tsx` (new); `pages/CheckoutPage.tsx` (new); `pages/EventDetailPage.tsx`: `HoldForm` per tier; `App.tsx`: `/checkout/:token`; `styles.css`                                                                           |

### Key files

| File                                                        | What it does                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/web/src/components/Countdown.tsx`                 | display only; anchors on `remainingMs`; asks once at zero and clears its own interval                                 |
| `packages/web/src/pages/CheckoutPage.tsx`                   | hold → its event (a cache hit) → summary; a 404 is data (`null`), not a message to parse; Release → back to the event |
| `packages/api/src/presentation/http/routes/holds.ts`        | `POST /holds` 201 · `GET /holds/:token` 200/404 · `DELETE /holds/:token` 200                                          |
| `packages/api/src/infrastructure/redis/seedLiveCounters.ts` | `HSETNX` per tier; a second run writes nothing                                                                        |
| `packages/api/src/main/seed.ts`                             | Redis first, then rows, then counters                                                                                 |
| `packages/api/test/integration/http/support.ts`             | `unusedEventController()`, `unusedHoldController()`, `unusedStatsController()` for route tests                        |
| `packages/web/e2e/e2e-2b-hold-failure-paths.spec.ts`        | the clock jump, zero, the 409 under the button, the failed release                                                    |

### Redis keys introduced

| Key            | Type | TTL | Who writes it                                 | Who reads it      |
| -------------- | ---- | --- | --------------------------------------------- | ----------------- |
| none new       |      |     | `tier:<id> remaining` now written by the seed | unchanged         |
| `hold:<token>` | hash | —   | gains the field `eventId` (TB-022's shape +1) | `find`, `GetHold` |

### Lua scripts introduced

| Script   | The race it prevents                                         |
| -------- | ------------------------------------------------------------ |
| none new | `create_hold.lua` takes `eventId` as `ARGV[7]` and stores it |

---

## 3. Where this diverged from the plan

| Planned                                                                                                                                                  | What actually happened                                                                                                                                                                          | Why                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision 5: `Countdown({ expiresAt, onZero })`; "a skewed browser shows a wrong number and still re-fetches; alive → restart from the fresh `expiresAt`" | `Countdown({ remainingMs, onZero })`, anchored on elapsed time; the interval clears itself at zero                                                                                              | **Review Critical.** "Restart from the fresh `expiresAt`" on a clock ahead of the server is a loop: zero again on the next render, 190 GETs in 3 s. The plan reasoned about a wrong _number_; the bug was a wrong _decision_ made every second. |
| Decision 3: the upper bound on `qty` surfaced as `InvalidQuantity`, mapped to 400                                                                        | `max(Quantity.MAX_PER_HOLD)` in the schema; `InvalidQuantity` unmapped again                                                                                                                    | Review Major: a reference is not a copy, and mapping an invariant to 400 gave the error table a row for a throw no route should reach.                                                                                                          |
| Decision 1: "a Redis that is down fails the seed loudly rather than seeding half the system"                                                             | True only once Redis is opened _first_. The first `seed.ts` wrote the rows, then failed on Redis                                                                                                | Review Major. The sentence was right and the order was wrong.                                                                                                                                                                                   |
| Decision 6: "the UI never compares `qty` to `remaining`"                                                                                                 | It also must not disable the button on `remaining === 0`, which the first form did                                                                                                              | Review Major: a snapshot deciding "sold out" is the rule in a second place. The E2E now clicks the sold-out tier and reads the 409.                                                                                                             |
| The checkout page detects a gone hold from the error message's `404` prefix                                                                              | The loader returns `null` on `ApiError` 404; the page branches on data                                                                                                                          | Review Major: parsing a message the client itself formatted.                                                                                                                                                                                    |
| §4 did not list `test/integration/http/support.ts`                                                                                                       | Added: three `unused*Controller()` helpers replacing copy-pasted controller construction in four route tests                                                                                    | The fourth copy was the one too many.                                                                                                                                                                                                           |
| §4 listed `hold-mirror.test.ts` as changed                                                                                                               | Deleted; its assertion (key and row agree on status and number) lives in `composition.test.ts` through the real routes                                                                          | TB-024's own follow-up; the routes now exist.                                                                                                                                                                                                   |
| E2E spec files run in parallel                                                                                                                           | `workers: 1`: every spec that holds tickets moves the number every other spec reads                                                                                                             | Found on the first full run (998 where 1000 was expected). `fullyParallel: false` was added too and removed in review as redundant.                                                                                                             |
| §5 E2E "the Acceptance line"                                                                                                                             | Plus a second file of failure paths the review named: the clock jump (one read, then silence), zero (one read, the server's answer), the 409 under the button, the failed release               | Review "For the Test Phase". The first version of the clock-jump spec asserted _zero_ reads and passed for the wrong reason (the one request had not reached the test process); rewritten to assert what is true, and watched go red.           |
| §5 "a hash without `eventId` is a bug"                                                                                                                   | Written in Phase 4, not with the code: `find` throws naming the field; `GET /holds/:token` on such a key is a 500 `INTERNAL`, never a 404                                                       | Listed in the plan, missed in Phase 2, caught by the review's test-phase block.                                                                                                                                                                 |
| §4 listed `docs/tasks/TB-020…024` for follow-up ticks                                                                                                    | Ticked: the seed answers "who seeds the counters" (TB-022, TB-023, TB-024); the UI keeps the event it came from, so `TicketTierRepository` stays unused (TB-020); `hold-mirror` folded (TB-024) | As planned, for once.                                                                                                                                                                                                                           |

---

## 4. Tests shipped

| Level       | Test file                                                                                     | Behaviour asserted                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `test/unit/domain/entities/Hold.test.ts`, `use-cases/CreateHold.test.ts`, `GetHold.test.ts`   | `eventId` kept, returned, handed to the store                                                                                                                                                                                                                                                                                                    |
| Unit        | `test/unit/infrastructure/system/UuidTokenGenerator.test.ts`, `test/unit/main/config.test.ts` | a v4 UUID, different each call; `HOLD_TTL_MS` default 120 000, rejects 0 and non-integers                                                                                                                                                                                                                                                        |
| Unit (web)  | `test/unit/api/client.test.ts`                                                                | `createHold` posts JSON, returns the 201 body; `getHold` by encoded token; `releaseHold` sends DELETE; a 409 is an `ApiError` with the envelope's code                                                                                                                                                                                           |
| Integration | `test/integration/redis/RedisHoldStore.test.ts`, `seedLiveCounters.test.ts`                   | the script writes `eventId`; `find` reads it back; **a four-field hash from before TB-025 throws naming `eventId`**; the seed writes every tier once, a second run nothing, a present counter is left alone                                                                                                                                      |
| Integration | `test/integration/http/holds.test.ts`                                                         | `POST` 201 shape; unknown event / tier 404 **told apart by message**; 409 `INSUFFICIENT` with inventory untouched; qty 0 / 11 / 1.5 → 400 before inventory; `GET` 200 with `remainingMs`, 404 for expired / released / never issued; `DELETE` 200 both ways; malformed token 400                                                                 |
| Integration | `test/integration/main/composition.test.ts`                                                   | through the real stack: 201 → page shows 998 → `GET` 200 → row `active` → `DELETE` → row `released` → 1000; 409 on VIP; **a pre-TB-025 hold key answers 500, not 404**                                                                                                                                                                           |
| Concurrency | —                                                                                             | none new; no new inventory path (TB-022/023 own it)                                                                                                                                                                                                                                                                                              |
| Smoke       | `test/smoke/smoke.test.ts`                                                                    | `POST /holds` 1 ticket → 201, then `DELETE` → 200: the last todo is real                                                                                                                                                                                                                                                                         |
| E2E         | `e2e/e2e-2-hold-and-release.spec.ts`                                                          | 1000 → set 2 → checkout → `1:5x` then a lower value → summary → Release → 1000; the number drops to 999 as seen from a fresh load; `afterEach` releases the captured token                                                                                                                                                                       |
| E2E         | `e2e/e2e-2b-hold-failure-paths.spec.ts`                                                       | **a clock jump of ten minutes: exactly one `GET /holds/:token`, the countdown remounts at `1:5x`, no further read over three more seconds**; at zero (hold released behind the page): `hold-gone` and exactly one read; the sold-out tier offers the button and shows "not enough tickets"; a 503 on DELETE leaves the error and the button live |

Final run on `d506edd` + the spec rewrite: typecheck clean, `lint --max-warnings 0` clean, api unit **163**, web unit **13**, api integration **172** (16 files), smoke **6**, E2E **7**. General counter `1000` and zero `hold:*` keys after every run.

**Proven able to fail** — six sabotages here, each restored from git; the reviewer ran its own reproduction of the loop on `9b70076` (190 requests in 3 s):

```
S1  Countdown anchor ten minutes short (the C1 shape)       e2e-2b "clock jump": Expected 1, Received 2
S2  Countdown never calls onZero                            e2e-2b "at zero": hold-gone not visible
S3  button disabled on tier.remaining === 0                 e2e-2b "sold-out tier": 1 failed
S4  a failed release navigates away anyway                  e2e-2b "release that fails": 1 failed
S5  find defaults a missing eventId                         RedisHoldStore "hash from before the eventId field": ×
                                                            composition "500, not 404": ×
```

One lesson from S1: the first clock-jump spec asserted zero reads and stayed green under S1 as well, because the request event from the page's one fetch had not reached the test process when it counted. A test that cannot go red is not a test; the sabotage is what found it.

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It reproduced the countdown loop in Chromium with a skewed clock, ran the seed against a dead Redis port, and re-verified every finding on the fix commit.
**Verdict:** **NEEDS WORK** (Critical: the countdown loop) → fixed in `95be1d8` → re-reviewed → **SAFE TO MERGE** with two dead casts to delete (deleted in `d506edd`).

| Finding                                                                                                                              | Severity              | Resolution                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| Countdown re-fetches in a loop on a browser clock ahead of the server                                                                | Critical              | Anchored on `remainingMs`; interval cleared at zero; E2E with the clock installed before navigation |
| `seed.ts` wrote rows before finding Redis down                                                                                       | Major                 | Redis opened first, error listener, the cause named                                                 |
| Checkout detected a gone hold from the message prefix `404`                                                                          | Major                 | 404 carried as `null` data                                                                          |
| Button disabled on `remaining === 0`: the browser deciding sold out                                                                  | Major                 | Only `pending` disables; E2E clicks the sold-out tier                                               |
| `InvalidQuantity` mapped to 400; bound not in the schema                                                                             | Major                 | `max(Quantity.MAX_PER_HOLD)` in the schema; the row removed                                         |
| The two 404s not told apart in the route test                                                                                        | Major                 | `/^event /` and `/^tier /` asserted                                                                 |
| An E2E that fails after holding leaves the counter wrong for every later spec                                                        | Major                 | `afterEach` releases the captured token                                                             |
| Stale comments (composition, `keys.ts`), `.env.example`, duplicated id mapping, `Summary` component, GET 400 schema, `fullyParallel` | Minor                 | All applied                                                                                         |
| Two uncommented dead `as string` casts (re-review)                                                                                   | Critical (mechanical) | Deleted                                                                                             |
| `required` dead on a controlled number input; `import()` type form; untyped `json()` (re-review)                                     | Minor                 | All applied                                                                                         |

Findings deliberately **not** fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** `POST /holds` → 500 (`reserve` throws before the row); `GET /holds/:token` → 500; the event page renders from the computed count; `pnpm seed` fails before writing a row — **tested by hand**: `REDIS_URL=redis://localhost:6390 pnpm seed` → `Error: seed: redis is unreachable at redis://localhost:6390: connect ECONNREFUSED 127.0.0.1:6390`, exit 1, no `inserted` line.
- **Postgres down at seed time:** Redis connects, `seed(client)` throws, no counter is written (the counters come after the rows), `finally` closes both.
- **Key evicted under `allkeys-lru`:** a hold: the checkout page asks at zero (or on reload) and shows "expired"; its tickets come back with the sweeper (TB-026). A counter: every `POST /holds` on that tier is a 409 that the sold-out E2E would also show — on a tier the page says has 1000. Reconcile (TB-027).
- **Browser clock skewed by a constant:** invisible; the page measures elapsed time. **Jumping mid-page:** one extra question to the server, then the countdown continues from its answer. Tested.
- **Runs twice:** a double click creates two holds; the second navigation wins and the first expires on its own (TB-030 makes `POST /holds` idempotent). A double Release: the second answers `released: false`, the page navigates either way.
- **Dies halfway:** as TB-024 — a hold with no row, or a released hold with an `active` row. The browser adds nothing new: at worst a checkout page for a token the server has forgotten, which is the 404 path.
- **Release fails (5xx):** the hold stays on screen with the error and the button live; the hold is still the server's, and the countdown is still counting. Tested with an intercepted DELETE.

---

## 7. What I'd do differently

Reason about the countdown as a _decision made every second_, not as a number shown once. The plan's sentence "a skewed browser shows a wrong number and still re-fetches" was true and missed that it re-fetches _again_. And when a test passes on the first run against a behaviour this subtle, break the code before believing it — the zero-reads spec would have shipped green and meaningless.

---

## 8. Follow-ups left behind

- [x] TB-026: the sweeper. Until it exists an abandoned hold's tickets come back only when something releases them — the E2E's `afterEach` is a stand-in, not a design. _Done; the `afterEach` stays, because CI does not run the worker and a failed spec should not wait two minutes._
- [ ] TB-030 (was TB-029, whose Scope line is the use case and the route): `Countdown` and `CheckoutPage` gain Confirm; the summary deliberately shows no total (qty × price is the first arithmetic about money the browser would do).
- [ ] TB-030: idempotent `POST /holds` — the double click above.
- [ ] TB-038: the countdown's 1 s interval is not aligned to the second boundary; display only, fine until the live UI redraws more.
- [ ] `application/ports/TicketTierRepository.ts` is still unused (TB-020's note): the checkout page gets the tier from the event it came from. Delete it when a task is sure nothing will need it.
