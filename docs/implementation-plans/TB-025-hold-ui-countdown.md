# TB-025 — Hold UI with countdown

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-025 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-025-hold-ui-countdown` (stacked on `feat/TB-024-postgres-hold-mirror`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decisions 1 and 2 are the ones to read first**: who seeds the live counters, and the `Hold` entity learning its event.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** quantity picker and "Get tickets" on the event page; a checkout page at `/checkout/:token` showing the countdown from the server-provided `expiresAt`, an order summary, and a "Release" button. At zero, the UI re-fetches rather than assuming the hold is dead.

**Acceptance:** you can click, see the number drop, see a timer tick, and release the hold to see it go back up. **This is the first moment the project feels real.**

**Tests:** **E2E-2 (partial)** — get tickets, land on checkout, see a timer counting down, release, and confirm availability is restored.

**Depends on:** TB-023, TB-014 — in the stack below this branch (nothing is merged by the session's instruction): ☑

---

## 2. What I understand this to mean

The write path reaches the browser. That needs two routes the Scope line names only by their screens — `POST /holds` and `GET /holds/:token` (handbook §2.5 and §3.3; the smoke suite's last todo) — the token generator and the TTL setting the composition root has been missing, and three UI pieces: a picker and a button per tier, a checkout page that counts down from the server's `expiresAt` and re-fetches at zero, and a Release button. Nothing in the browser decides anything: it posts, it renders what it is given, it counts a number down for display, and it asks again.

It also needs an answer to the question every task since TB-022 has carried: **nothing writes the live counter**, so no hold can be created against any tier. This plan answers it (decision 1).

---

## 3. Approach

### Layers touched

| Layer                | What changes                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`       | `Hold` gains `eventId` (decision 2); `errors/InsufficientInventory.ts`, `errors/HoldNotFound.ts` (new)                                                                                                     |
| L2 `application/**`  | `CreateHold` passes `eventId` into the hold and returns it; `GetHold` returns `eventId`                                                                                                                    |
| L3 `infrastructure/` | `redis/`: `create_hold.lua` + `RedisHoldStore` store and read `eventId`; `redis/seedLiveCounters.ts` (new, decision 1); `system/UuidTokenGenerator.ts` (new)                                               |
| L3 `presentation/`   | `dto/holds.ts`: `CreateHoldRequest`, `HoldResponse`, `CreatedHoldResponse`; `HoldController.create/get`; `routes/holds.ts`: `POST /holds`, `GET /holds/:token`; `http/errors.ts`: two rows                 |
| L4 `main/`           | `config.ts`: `HOLD_TTL_MS`; `composition.ts`: `CreateHoldUseCase`, `GetHoldUseCase`, `UuidTokenGenerator`; `seed.ts`: seeds the live counters too                                                          |
| web                  | `api/client.ts`: `createHold`, `getHold`, `releaseHold`; `pages/EventDetailPage.tsx` (picker + button per tier); `pages/CheckoutPage.tsx`, `components/Countdown.tsx` (new); `App.tsx` route; `styles.css` |
| repo root            | `scripts/lua/create_hold.lua` (one more ARGV / field)                                                                                                                                                      |

### Decisions this plan is making

1. **`pnpm seed` seeds the live counters, with `HSETNX`.** Every tier the seed inserts gets `tier:<id> remaining = total_qty` in Redis — only if the field is absent, so a second run writes nothing, like the SQL's `ON CONFLICT DO NOTHING`. This is the dev and CI bootstrap, not the production mechanism: a Redis that lost its counters while holds and orders exist must be rebuilt from Postgres's computed count, which is reconciliation (TB-027), and `HSETNX` is deliberately too dumb to do that (it would seed `total_qty` over a used database). Why here and not TB-027: this task's Acceptance line is a click that creates a hold, the smoke suite's `POST /holds` and E2E-2 run in CI straight after `pnpm seed`, and the alternative — building the reconcile endpoint now — is TB-027's whole scope. The function lives in `infrastructure/redis/seedLiveCounters.ts` (it needs the key registry) and `main/seed.ts` calls it with a client it opens and closes; a Redis that is down fails the seed loudly rather than seeding half the system — **(amended in review)** by opening Redis _first_, before a single row is written: the shipped seed as first written connected to Postgres, wrote the rows, and only then found Redis unreachable, which is exactly "half the system". Recorded in ADR 0002's "what would make us revisit" as the first writer of the counter.
2. **`Hold` learns its `eventId`.** The checkout page is reached by token alone and must show an order summary — event, tier, quantity, price — and the hold knows only its tier. Two ways to get from a tier to its event: a new `PgTicketTierRepository` behind the unused `TicketTierRepository` port plus a second lookup in `GetHold`, or the hold carrying the event id it was created for. The second is one field: `CreateHold` already has the event in hand, the entity stores it, the script writes it into the hash (`ARGV[7]`), `find` reads it back, `GetHold` returns it, and the browser fetches `GET /events/:id` (a cache hit) to render names and prices. The mirror row keeps `tier_id` only (the foreign key already knows the event); no migration. `TicketTierRepository` stays unused — TB-020's follow-up closes as "not this way".
3. **`POST /holds` → `201 { token, eventId, tierId, qty, expiresAt, remaining }`; `GET /holds/:token` → `200 { token, eventId, tierId, qty, expiresAt, remainingMs }`.** Body validated as `{ eventId: uuid, tierId: uuid, qty: int ≥ 1 }` — the upper bound stays the entity's (`Quantity.MAX_PER_HOLD`), surfaced as the `InvalidQuantity` throw TB-008 decision 9 chose, not a second copy in the schema **(amended in review: wrong — the schema now _references_ the constant, `max(Quantity.MAX_PER_HOLD)`, which is one copy, not two; mapping `InvalidQuantity` to a 400 made an entity invariant a client error and gave the one error table a row for a throw no route should ever reach. `InvalidQuantity` is unmapped again, a 500 like any other bug)**; the controller maps `unknown-event` → `EventNotFound` (404), `unknown-tier` → `TierNotFound` (404), `insufficient` → **`InsufficientInventory` (409 `INSUFFICIENT`)**, `GetHold`'s `not-found` → **`HoldNotFound` (404)**. Two new domain errors, two rows in the one error table. The same `if (!result.ok) throw` shape `EventController` uses.
4. **`UuidTokenGenerator` is `crypto.randomUUID()`** in `infrastructure/system/`, matching the `z.uuid()` TB-023 put on the token param. **`HOLD_TTL_MS`** joins `config.ts` (int ≥ 1, default 120 000) so TB-028a's test-only short TTL is one env var away, as that task's Scope line says.
5. **The countdown is a component that owns a 1 s interval and nothing else.** `Countdown({ expiresAt, onZero })` renders `max(0, expiresAt − Date.now())` as m:ss, ticking on `setInterval`; at zero it calls `onZero` once, and the page re-fetches the hold. `Date.now()` in the browser is display arithmetic against the server's instant (handbook §3.2: the server is the authority); a clock-skewed browser shows a wrong number and still re-fetches, and the re-fetch is what decides. At zero the page shows what the server says: `404` → "this hold has expired"; still alive (skew) → the countdown restarts from the fresh `expiresAt`. **(amended in review — Critical.)** "Restarts from the fresh `expiresAt`" is a loop: a browser clock ahead of the server computes zero again on the very next render, re-fetches, is told alive, and again — 190 GETs in 3 s, reproduced. The component is now `Countdown({ remainingMs, onZero })`: it anchors `Date.now() + remainingMs` on mount, so the browser's clock measures only _elapsed_ time, never the distance to an absolute instant, and it clears its own interval at zero so the re-fetch happens once per expiry. `expiresAt` stays in the DTO for the summary; the countdown never reads it.
6. **The quantity picker has no upper bound in the UI.** A `<select>` of 1–10 would be `Quantity.MAX_PER_HOLD` copied into the browser, and the web package may import nothing but DTO types from the API. A number input with `min="1"`; a quantity the API refuses comes back as a 400 (schema) or 409 (`INSUFFICIENT`) and is shown under the button, verbatim from the envelope. The UI never compares `qty` to `remaining` — **(amended in review)** and never disables the button on `remaining === 0` either, which the first implementation did: that is the browser deciding a tier is sold out from a snapshot, the same rule in a second place.
7. **The checkout page loads the hold, then the event**, in one `useRequest` load keyed by the token, and renders event name, tier name, unit price and quantity. No total: `qty × priceCents` is the first arithmetic the browser would do about money, and the handbook says the browser computes nothing; `POST /orders` (TB-029) will return the total. The email field and Confirm are TB-029's.
8. **Release navigates back to the event page**, where the number is seen to go back up — the Acceptance line's last clause — by the page's own fresh `GET /events/:id`; nothing in the browser adjusts a number it was shown.
9. **E2E-2 partial, as one spec file for the whole journey it can do today:** open the jazz event, `General` shows `1000 of 1000`, set 2, click Get tickets, land on `/checkout/<uuid>`, see a timer that reads `1:5x` then a lower value a second later, see the summary, click Release, land back on the event, `998 of 1000` → `1000 of 1000`. It runs in CI after `pnpm seed`, so decision 1 is what makes it possible. TB-029 extends the same file with Confirm and the order number.
10. **Smoke's last todo becomes real:** `POST /holds` for 1 ticket → 201, then the smoke test releases it (`DELETE`) so the seeded counter is left as it was for the next suite.

### New or changed ports

None. `HoldStore.reserve(hold)` carries the new field inside the entity; `find` returns it the same way.

### Redis keys

None new. The hold hash gains a field: `{ tierId, eventId, qty, createdAt, expiresAt }`. Live keys written by TB-022's script lack `eventId`; `find` treats a hash without it as malformed (a bug) — there are no such keys in any environment that has run a seed since, and a `FLUSHDB` is the dev reset.

### Lua scripts

`create_hold.lua` — `ARGV[7] eventId`, written by the `HSET`. No other change; the header gains the field.

### Migrations

None.

---

## 4. Files

| File                                                                                                                                                               | New / Changed | Why                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------- |
| `packages/api/src/domain/entities/Hold.ts`                                                                                                                         | Changed       | `eventId` (decision 2)                          |
| `packages/api/src/domain/errors/{InsufficientInventory,HoldNotFound}.ts`                                                                                           | New           | decision 3                                      |
| `packages/api/src/application/use-cases/{CreateHold,GetHold}.ts`                                                                                                   | Changed       | `eventId` in and out                            |
| `scripts/lua/create_hold.lua`, `packages/api/src/infrastructure/redis/{scripts,RedisHoldStore}.ts`                                                                 | Changed       | the field                                       |
| `packages/api/src/infrastructure/redis/seedLiveCounters.ts`                                                                                                        | New           | decision 1                                      |
| `packages/api/src/infrastructure/system/UuidTokenGenerator.ts`                                                                                                     | New           | decision 4                                      |
| `packages/api/src/presentation/dto/holds.ts`, `http/controllers/HoldController.ts`, `http/routes/holds.ts`, `http/errors.ts`                                       | Changed       | the two routes                                  |
| `packages/api/src/main/{config,composition,seed}.ts`                                                                                                               | Changed       | `HOLD_TTL_MS`; wiring; counters                 |
| `packages/api/test/fakes/builders.ts`                                                                                                                              | Changed       | `aHold().forEvent()`                            |
| `packages/api/test/unit/**` touched by the entity and the use cases; `test/unit/infrastructure/system/UuidTokenGenerator.test.ts`, `test/unit/main/config.test.ts` | Changed / new |                                                 |
| `packages/api/test/integration/redis/{RedisHoldStore,seedLiveCounters}.test.ts`                                                                                    | Changed / new | the field; the seeding                          |
| `packages/api/test/integration/http/holds.test.ts`, `test/integration/main/composition.test.ts`                                                                    | Changed       | the two routes; `POST /holds` through the stack |
| `packages/api/test/smoke/smoke.test.ts`                                                                                                                            | Changed       | the last todo                                   |
| `packages/web/src/api/client.ts`, `pages/EventDetailPage.tsx`, `pages/CheckoutPage.tsx`, `components/Countdown.tsx`, `App.tsx`, `styles.css`                       | Changed / new | the screens                                     |
| `packages/web/test/unit/api/client.test.ts`, `packages/web/e2e/e2e-2-hold-and-release.spec.ts`                                                                     | Changed / new | the client; E2E-2 partial                       |
| `docs/adr/0002-…`                                                                                                                                                  | Changed       | the first writer of the counter (decision 1)    |
| `docs/tasks/TB-020-…`, `TB-022-…`, `TB-023-…`, `TB-024-…`                                                                                                          | Changed       | the seeding follow-up, closed                   |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                | What it would catch                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Unit        | `Hold.create` keeps `eventId`; `CreateHold` returns it and hands it to the store; `GetHold` returns it                                                                                              | the field dropped on one side                        |
| Unit        | `UuidTokenGenerator`: a v4 UUID, different each call; `config`: `HOLD_TTL_MS` default 120 000, rejects 0 and non-integers                                                                           | a token the route's `z.uuid()` would refuse; a 0 TTL |
| Unit (web)  | the client: `createHold` posts JSON and returns the 201 body; `getHold` fetches by encoded token; `releaseHold` sends `DELETE`; a 409 becomes an `ApiError` with the envelope's code                | the three calls wired to the wrong verb or path      |
| Integration | the script writes `eventId`; `find` reads it back; a hash without it is a bug                                                                                                                       | decision 2 on the Redis side                         |
| Integration | `seedLiveCounters`: writes `total_qty` for every seeded tier; a second run changes nothing; a counter already present is left alone                                                                 | decision 1                                           |
| Integration | route: `POST /holds` → 201 with the body shape; unknown event 404; unknown tier 404; insufficient 409 `INSUFFICIENT`; qty 0 / 11 → 400; `GET /holds/:token` → 200 with `remainingMs`; unknown → 404 | the controller's mapping; the error table            |
| Integration | composition: `POST /holds` through the real stack (counter seeded by `seedLiveCounters`) → 201; `GET /events/:id` shows the drop; `DELETE` → back                                                   | the wiring, end to end, before the browser           |
| Smoke       | `POST /holds` 1 ticket → 201, then `DELETE` → 200                                                                                                                                                   | the last todo                                        |
| E2E         | E2E-2 partial, decision 9                                                                                                                                                                           | the Acceptance line                                  |
| Concurrency | none new — the store's reserve/release tests (TB-022/023) own it                                                                                                                                    |                                                      |

**Concurrency:** no new inventory path.

**How each test will be proven able to fail:** drop `eventId` from the `HSET` (find test red, E2E red at the summary); `HSET` instead of `HSETNX` in the seeder (second-run test red); 404 for insufficient (route test red); the countdown counting up (E2E red); Release without navigating (E2E red at the restored number); the picker sending `qty` as a string (route 400, E2E red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `POST /holds` → 500 (`reserve` throws, fail closed); `GET /holds/:token` → 500; the event page still renders from the computed count. The seed fails loudly. TB-039 picks the status.
- **What if a key is evicted under `allkeys-lru`?** A hold: the checkout page re-fetches at zero (or earlier, on reload) and sees 404 — "expired"; its tickets come back with the sweeper. A counter: every `POST /holds` on that tier is 409 until reconcile — visible now as "Insufficient" on a tier that shows 1000. Worth knowing; TB-027.
- **What if this operation runs twice?** A double click on Get tickets creates two holds (two tokens); the second navigation wins and the first hold expires on its own. Idempotent `POST /holds` is TB-030's; the button disables while the request is in flight, which is UX, not correctness.
- **What if it dies halfway through?** As TB-024's ADR: a hold with no row, or a release with a row still active. Nothing new here.
- **Seeding over a used database:** `HSETNX` writes nothing where a counter exists and `total_qty` where it does not — wrong if the counter was lost while holds exist. Dev and CI start empty; production has reconcile (TB-027).

---

## 7. Could Postgres already do this?

The counter seed could be a `SELECT` of the computed count instead of `total_qty` — that _is_ reconcile, and it is the right production answer (TB-027). The seed uses `total_qty` because at seed time nothing has been sold or held, and because a seed that computes is a reconcile with a worse name.

---

## 8. Open questions

None blocking. Decision 1 is the one to argue: a reviewer may prefer the counter to come from the computed count even at seed time. Decision 2's alternative (a tier repository) is the other.

---

## 9. Documentation this task will produce

- ☐ ADR — none new; one line in ADR 0002 for the seed as the counter's first writer
- ☑ Task doc — `docs/tasks/TB-025-hold-ui-countdown.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
