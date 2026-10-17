# TB-030 — Redis idempotency layer

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-030 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-030-redis-idempotency` (stacked on `feat/TB-029-confirm-order`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decisions 1, 2 and 6 are the ones to read first**: where the layer lives, what the in-progress marker's lifetime does to a crashed request, and the Confirm UI riding here.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** `Idempotency-Key` header required on `POST /orders`. `SET idem:{key} "in-progress" NX EX 86400`; the winner processes and overwrites with the serialised response; a loser gets 409 while in progress, or a replay with `Idempotency-Replayed: true` once complete. Store a body hash — same key with a different body returns 422.

**Acceptance:** keep the Postgres `UNIQUE` constraint too. Bypass Redis deliberately and confirm Postgres still refuses the duplicate. **Both layers, on purpose:** constraint for truth, Redis for speed.

**Tests:** **integration** — 10 concurrent requests with the same key produce exactly one order row; a replay returns the identical body; the same key with a different body returns 422.
**Tests:** **E2E-5** — double-click Confirm rapidly, exactly one order.

**Depends on:** TB-029 — confirmed merged: ☐ (stacked: #34 is open, not merged, by the session's instruction; this branch contains it)

---

## 2. What I understand this to mean

The same request twice must cost once. The constraint (TB-029) already guarantees that — one key, one order row — but it guarantees it by refusing the second request, and burns its hold on the way (ADR 0007's first window). This task puts the fast path in front: the first request with a key claims it in Redis with `SET NX`, does the work, and stores what it answered; every later request with that key gets the same answer back, marked as a replay, without touching the hold, the use case or Postgres. A concurrent duplicate — the double-click — finds the claim taken and the answer not yet there, and is told 409 to try again in a moment. A key reused with a different body is a client bug and is told 422. The constraint stays, and the Acceptance line makes the stack prove it still works with the fast path removed. The Confirm button and the email field arrive with this task, because E2E-5 is a double-click on them and nothing before this task could absorb one.

---

## 3. Approach

### Layers touched

| Layer                                     | What changes                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing                                                                                                                                                                                                                                                                |
| L2 `application/**`                       | `ports/IdempotencyStore.ts` (new)                                                                                                                                                                                                                                      |
| L3 `infrastructure/**`, `presentation/**` | `redis/keys.ts`: `idempotency(key)`; `redis/RedisIdempotencyStore.ts` (new); `http/idempotency.ts` (new: the two route hooks); `routes/orders.ts`: header required, hooks attached; `dto/orders.ts`: the header schema required; `http/errors.ts`: `envelope` exported |
| L4 `main/**`                              | `composition.ts`: `RedisIdempotencyStore`, handed to the orders route                                                                                                                                                                                                  |
| web                                       | `api/client.ts`: `createOrder(input, idempotencyKey)`; `pages/CheckoutPage.tsx`: the email field, Confirm, the order view; `styles.css`                                                                                                                                |
| E2E                                       | `e2e-2-hold-and-release.spec.ts`: the confirm journey (E2E-2's second half); `e2e-5-double-click.spec.ts` (new)                                                                                                                                                        |

### Decisions this plan is making

1. **The layer is two route-scoped Fastify hooks over a port, not a use case and not a controller branch.** What is stored and replayed is the _serialised HTTP response_ — status and body bytes — and the header that marks a replay is HTTP; none of that belongs in L2. `presentation/http/idempotency.ts` exports `idempotencyHooks(store)`: a `preHandler` that reads the key, fingerprints the validated body, calls `store.begin(key, fingerprint)` and either lets the handler run (`won`), replies `409 IN_PROGRESS`, replies `422 MISMATCH`, or replies the stored status and body with `Idempotency-Replayed: true`; and an `onSend` that, after the handler (or the error handler) produced the response, calls `store.complete(key, fingerprint, { status, body })` for any status below 500 and `store.abandon(key)` for a 500, so a crash on our side does not get replayed for a day. Route-scoped: `POST /orders` is the only route with a key. The port is `application/ports/IdempotencyStore.ts` — idempotency is in the handbook's Redis-vs-Postgres table as an application concern, and the adapter is Redis.

2. **The in-progress marker lives as long as the stored answer: `SET … NX EX 86400`, as the Scope line says — and that is the one failure mode worth stating up front.** A request that claims the key and then dies (the process, not the handler: a handler error reaches `onSend` and is abandoned) leaves `in-progress` for a day; every retry with that key is a 409 for a day. The client's recourse is a new key, which is a new attempt: the hold behind the old one was consumed or is still alive, and TB-029's receipts decide what the new attempt gets. A shorter marker TTL would trade this for a worse one — a slow request outliving its marker lets a duplicate run in parallel — and the Scope line chose. Said in ADR 0008 and §6.

3. **The stored value is one JSON string, written twice with `EX`.** `{ "state": "in-progress", "fingerprint" }` on claim; `{ "state": "done", "fingerprint", "status", "body" }` on completion, with `SET … EX 86400` again — never a bare `SET`, which would drop the TTL and make the answer immortal (TB-019a's lesson, in production code for the first time). One key, one value, no hash fields to keep in sync; `body` is the serialised payload Fastify handed `onSend`, replayed verbatim with `content-type: application/json`.

4. **The fingerprint is `sha256` of the validated body with sorted keys.** Computed after the schema accepted the body, so whitespace and key order do not count and an invalid body never reaches the store (a 400 is not a thing to remember). `{ holdToken, email }` today; TB-033's body will fingerprint the same way.

5. **The key is required and bounded — `z.string().min(1).max(200)` — and reaches Redis as `idem:<key>` under the registry.** A missing key is a 400 from the schema (the DTO's `IdempotencyHeaders` goes from optional to required). The key is a client secret in the same sense as the token: never logged (CLAUDE.md), and TB-029's log test already pins that.

6. **The checkout page gains the email field, the Confirm button and the confirmed view; the key is minted once per page.** `crypto.randomUUID()` when the hold loads, held in state: a double-click sends the same key twice, a reload is a new attempt (a new key, against a hold that is by then consumed → 410, or alive → a second order is impossible anyway). On success the page shows `Order <id>` and the server's total — the first money arithmetic the browser displays is the server's number, not its own. The button disables while pending; E2E-5 double-clicks faster than React re-renders, which is the point. The checkout page stays dumb: it posts, shows what came back, and never decides anything.

7. **The confirm journeys run on the second seed event.** A sale is permanent, and every other spec reads the jazz event's exact numbers; the comedy event is read by nothing but the smoke suite's one order per run, so the specs assert the order number and relative numbers, never an absolute count on it.

8. **E2E-2's second half and E2E-5:** E2E-2 gains "confirm → an order number is shown" (the handbook's happy path, complete); E2E-5 is `dblclick` on Confirm → one order number shown, and the proof that there is one order: a third `POST /orders` with the same key and body through the `request` fixture answers the identical body with `Idempotency-Replayed: true`. The integration test with ten concurrent real requests is where "exactly one row" is asserted against Postgres.

9. **Bypass Redis deliberately (the Acceptance line):** in the composition test, after a confirm, `DEL` the key from Redis and send the same key with a _fresh_ hold — the fast path is gone, the request reaches Postgres, the constraint refuses it with `409 CONFLICT` (TB-029's translation), and the fresh hold is burned (ADR 0007's window, now reachable only by bypassing Redis). The same key with the same hold reaches Redis-less `consume` first and is a 410, which is the constraint never being asked — the test says so.

10. **Could Postgres already do this?** §7 — it does half of it, and the half it does is the half that matters for truth. The Redis half is the response replay and the fast refusal; the handbook's table says "use both", and the Acceptance line is that sentence as a test.

### New or changed ports

```ts
// application/ports/IdempotencyStore.ts
export interface StoredResponse {
  readonly status: number;
  readonly body: string;
}
export type BeginOutcome =
  | { outcome: "won" }
  | { outcome: "in-progress" }
  | { outcome: "mismatch" }
  | { outcome: "replay"; response: StoredResponse };
export interface IdempotencyStore {
  /** Claim the key for this fingerprint, or learn what became of it. */
  begin(key: string, fingerprint: string): Promise<BeginOutcome>;
  /** The winner's answer, kept for as long as the claim. */
  complete(key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  /** The winner failed on our side: let the next request with this key try. */
  abandon(key: string): Promise<void>;
}
```

Fake: `InMemoryIdempotencyStore` (a Map; `begin` synchronous in effect, so ten concurrent requests in one process see one winner).

### Redis keys

`ticketbox:v1:idem:<key>` — string, JSON, `EX 86400` on both writes. In `keys.ts` as `idempotency(key)`.

### Lua scripts

None. `SET NX EX` is one atomic command and the decision it makes is the whole mechanism; the `GET` that follows a lost claim reads a value that is already final or in progress, and both answers are right.

### Migrations

None.

---

## 4. Files

| File                                                                                               | New / Changed | Why                                          |
| -------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------- |
| `packages/api/src/application/ports/IdempotencyStore.ts`                                           | New           | decision 1                                   |
| `packages/api/src/infrastructure/redis/{keys,RedisIdempotencyStore}.ts`                            | Changed / new | decisions 3, 5                               |
| `packages/api/src/presentation/http/idempotency.ts`                                                | New           | decision 1                                   |
| `packages/api/src/presentation/http/{errors,server}.ts`, `routes/orders.ts`, `dto/orders.ts`       | Changed       | `envelope` exported; hooks; header required  |
| `packages/api/src/main/composition.ts`                                                             | Changed       | wiring                                       |
| `packages/api/test/fakes/InMemoryIdempotencyStore.ts`                                              | New           | the fake                                     |
| `packages/api/test/integration/redis/RedisIdempotencyStore.test.ts`                                | New           | §5                                           |
| `packages/api/test/integration/http/orders.test.ts`, `support.ts` + the route tests' `orders:` dep | Changed       | the header required; the hooks over the fake |
| `packages/api/test/integration/main/composition.test.ts`                                           | Changed       | ten concurrent; bypass Redis                 |
| `packages/api/test/smoke/smoke.test.ts`                                                            | Changed       | the header                                   |
| `packages/web/src/api/client.ts`, `pages/CheckoutPage.tsx`, `styles.css`                           | Changed       | decision 6                                   |
| `packages/web/test/unit/api/client.test.ts`                                                        | Changed       | `createOrder` sends the header               |
| `packages/web/e2e/e2e-2-hold-and-release.spec.ts`, `e2e-5-double-click.spec.ts`                    | Changed / new | decision 8                                   |
| `docs/adr/0008-two-layers-of-idempotency.md`                                                       | New           | decisions 1–3, 9                             |
| `docs/adr/0007-…`, `docs/tasks/TB-025-…`, `TB-029-…`                                               | Changed       | revisit line; follow-ups                     |
| `docs/02-product-delivery-plan.md`                                                                 | Changed       | tracker                                      |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                                                                                                                                                                                                  | What it would catch                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Integration | `RedisIdempotencyStore`: the first `begin` wins; a second with the same fingerprint → `in-progress`; after `complete` → `replay` with the stored status and body; a different fingerprint → `mismatch` (before and after completion); **both writes carry a TTL** (the stored answer is not immortal); `abandon` frees the key; `begin` after the marker expired wins again           | the mechanism; TB-019a's `SET` trap                  |
| Integration | route over the fake: a missing key → 400; **10 concurrent requests, same key and body → exactly one order in the fake repository**, one 201 and nine 409 or replays; a replay returns the identical body and `Idempotency-Replayed: true`; the same key with a different body → 422; a 410 is stored and replayed as a 410; a handler that throws → not stored, the next request runs | the hooks' every branch                              |
| Integration | composition: **10 concurrent real requests → one `orders` row**; the replay body identical; **bypass Redis (decision 9)**: `DEL` the key, a fresh hold with the old key → 409 from the constraint                                                                                                                                                                                     | the Acceptance line, both layers                     |
| Unit (web)  | `createOrder` posts the body with the `Idempotency-Key` header                                                                                                                                                                                                                                                                                                                        | the header missing from the browser's request        |
| Smoke       | the existing order case sends a key                                                                                                                                                                                                                                                                                                                                                   | the required header                                  |
| E2E         | E2E-2 completed: confirm → order number; **E2E-5**: double-click → one order number, a replay confirms one order                                                                                                                                                                                                                                                                      | the UI's key minted once; the layer from the browser |
| Concurrency | the ten-concurrent cases above, against the fake and against Redis                                                                                                                                                                                                                                                                                                                    | the claim not being atomic                           |

**Concurrency:** the ten-concurrent assertions are exact: one order, ten responses accounted for.

**How each test will be proven able to fail:** `SET NX` → `SET` (ten concurrent → more than one winner, red); the second `SET` without `EX` (the TTL test red: `-1`); the fingerprint not compared (422 test red); `onSend` storing 500s (the "handler throws" test red); the browser minting a key per click (E2E-5 red: two orders → the second a 410, the page showing an error); the header made optional again (400 test red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `begin` throws → 500 before the handler; orders fail closed (TB-039's rule), the hold is untouched, a retry with the same key works once Redis is back. No request reaches Postgres without a claim.
- **What if a key is evicted under `allkeys-lru`?** A claim or a stored answer gone: the next request with that key wins again and runs the use case — against a consumed hold that is a 410, against a fresh hold with a reused key it is the constraint's 409. The constraint is the truth; Redis was the speed (the Acceptance line, as an eviction).
- **What if this operation runs twice?** The task. Concurrently: one claim, 409 for the rest; after completion: replays. Twice with a different body: 422. Twice with the same key on different holds: the second never runs (replay), which is what closes ADR 0007's burned-hold window on the fast path.
- **What if it dies halfway through?** Between the claim and `onSend` with the process dying: `in-progress` for a day, 409s for that key, a new key is the way out (decision 2). A handler error: `abandon`, the next request runs. After `complete`: nothing to lose.
- **A slow winner:** a loser polls 409 until the answer is stored; nothing runs twice.
- **Replaying a 410:** correct — the same request, the same answer, for the same day.

---

## 7. Could Postgres already do this?

Half of it, and the half that matters: `UNIQUE (idempotency_key)` makes a second order with the same key impossible, and TB-029 already has it. What it cannot do is answer the duplicate with the first response — a constraint refuses, it does not remember — and it cannot refuse before the hold is consumed, which is the burned-hold window. Redis does both cheaply and forgets after a day, which is the right lifetime for "the same request". Two layers on purpose: the handbook's table says it, and the Acceptance line makes the stack prove it.

---

## 8. Open questions

None blocking. Decision 2 (the marker's day-long lifetime, per the Scope line) is the one to argue; decision 6 (the UI here, not in a UI task that does not exist) is a scope reading with E2E-5 as the reason.

---

## 9. Documentation this task will produce

- ☐ ADR — `docs/adr/0008-two-layers-of-idempotency.md`
- ☐ Task doc — `docs/tasks/TB-030-redis-idempotency.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
