# TB-027 — Reconciliation endpoint

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-027 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-027-reconciliation-endpoint` (stacked on `feat/TB-026-expired-hold-sweeper`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decisions 1 and 2 are the ones to read first**: reconcile repairs the mirror before it rebuilds the counter, and the window it cannot close.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** `POST /_admin/reconcile/:eventId` recomputing availability from Postgres and overwriting Redis. Report the drift found.

**Acceptance:** after `FLUSHDB`, one call restores correct availability.

**Tests:** **integration** — flush Redis, reconcile, assert availability matches the Postgres computation; introduce artificial drift and assert it's reported and corrected.

**Depends on:** TB-026 — confirmed merged: ☐ (stacked: #30 is open, not merged, by the session's instruction; this branch is based on it)

---

## 2. What I understand this to mean

The escape hatch for the day Redis and Postgres disagree: an operator calls one endpoint for one event, and afterwards the live counter of every tier of that event is what Postgres says it should be — `total − sold − held` — with a report of how far off each one was. The Acceptance line is the `FLUSHDB` rehearsal (TB-028's second experiment, done here first): every counter, every hold hash and every index entry gone; one call, and the numbers are right.

**What "right" has to mean, and why the Scope line's literal reading is not enough.** "Recompute from Postgres" is `total − sold − SUM(active rows)`. After a `FLUSHDB` the rows of every hold that was alive are still `active`, and nothing will ever change that: the holds are gone, the sweeper's index is gone, so the sweeper never finds them. Recomputed from those rows the counter is too low by their quantity — _forever_, not for two minutes — and so is the computed fallback. The second half of ADR 0004's hand-off to this task is the other direction: a hold alive in Redis with no row (the save failed and the compensating release failed too) is held tickets Postgres knows nothing about; rebuilt from the rows alone the counter is too high by its quantity, and when the sweeper later restores it the counter stays too high for good. So reconcile first makes the mirror agree with what Redis still holds — rows for holds that are gone become `expired`, holds with no row get their row — and _then_ recomputes from Postgres and overwrites Redis. The report says what it changed on both sides. That is still "recomputing from Postgres and overwriting Redis"; it is the two repairs that make the recomputation worth writing.

---

## 3. Approach

### Layers touched

| Layer                                     | What changes                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing                                                                                                                                                                                                                               |
| L2 `application/**`                       | `ports/HoldStore.ts`: `held(tierId)`, `rebuild(tierId, remaining)`; `ports/HoldRepository.ts`: `activeTokens(tierId)`; `use-cases/ReconcileEvent.ts` (new)                                                                            |
| L3 `infrastructure/**`, `presentation/**` | `RedisHoldStore`: `held` (the index, decoded), `rebuild` (`MULTI` `HGET`+`HSET`); `PgHoldRepository`: `activeTokens`; `dto/admin.ts`, `controllers/AdminController.ts`, `routes/admin.ts` (new); `server.ts`: `admin` in `ServerDeps` |
| L4 `main/**`                              | `composition.ts`: `ReconcileEventUseCase` over the **uncached** `PgEventRepository`, `AdminController`                                                                                                                                |

### Decisions this plan is making

1. **Reconcile repairs the mirror before it rebuilds the counter, in both directions.** Per tier of the event: (a) `held = holds.held(tierId)` — the index entries, which are the store's own list of what it still owes a restore for; (b) `rows = mirror.activeTokens(tierId)`; (c) every active row whose token is **not** in the index is a hold that is gone — swept, released, flushed, or evicted with its entry — and is marked `expired` (`setStatus`, first outcome kept, so a release's `setStatus` racing this one loses nothing but the label); (d) every index entry whose token has **no** active row is a hold Postgres never recorded: `find(token)` → `save(hold)`, which gives the sweeper a row to mark later and the computed count the right subtrahend; an entry whose hash is also gone (evicted, entry kept) cannot be recorded — the hash had the instants — and is reported as `unrecorded` and subtracted from that tier's target by its quantity, so the counter still counts it as held until the sweeper restores it. (e) `events.findById(eventId)` again, **uncached**, for the recomputed `remaining` per tier; (f) `holds.rebuild(tierId, target)` overwrites the counter and answers what was there. ADR 0004's revisit line ("reconcile needs the row to be more than a mirror") fires: the rows gain a read path, off the hot path. ADR 0006.

2. **The window reconcile cannot close, stated rather than hidden.** A reserve that lands between the Postgres read in (e) and the `HSET` in (f) decremented a counter that is then overwritten with the pre-reserve number: the counter is too high by that quantity until the next reconcile. Two stores, no cross-store atomicity; this is the same gap every line of ADR 0004's table lives in. The endpoint is an operator's escape hatch, run when the event is quiet, and TB-031's lock is where a stronger guarantee would come from. Not a reason to add a Lua script that cannot see Postgres anyway.

3. **The recomputation reads Postgres, never the cache.** `CachedEventRepository` serves `findById` from Redis for 300 s (TB-018); a reconcile that read it would write a five-minute-old number over the live counter. The composition root hands the use case the raw `PgEventRepository` — the one place the system is allowed to know there are two. The cached entry for the event is left alone: the page overlays the live counter on it (TB-022's `availability`), and a `DEL` of a cache key from inside a request is TB-019a's stall.

4. **`HoldStore.rebuild(tierId, remaining)` is `MULTI` / `HGET` / `HSET` / `EXEC`.** The before-value is for the report; `HSET` alone does not answer it, and two commands from the client have a round trip between them that a reserve can land in. `MULTI`/`EXEC` is the non-Lua way to make two commands one unit — a transaction queues commands and runs them without interleaving, no script, no `SCRIPT LOAD`, no loop. The first use of it in this codebase, and the right size for it. `HSET` without `EX` on a key with no TTL: nothing to lose.

5. **`HoldStore.held(tierId)`** lists the index — `ZRANGE 0 -1 WITHSCORES`, decoded with `holdIndex.ts` — as `{ token, qty, expiresAt }`. An entry that does not decode is skipped here (the sweeper removes it on its next pass; two writers for one cleanup is one too many).

6. **`HoldRepository.activeTokens(tierId)`**: `SELECT token FROM holds WHERE tier_id = $1 AND status = 'active'`. The row's first read path (decision 1); the `(tier_id, status)` index from TB-013 serves it.

7. **The route is `POST /_admin/reconcile/:eventId`**, `z.uuid()` param, `200` with the report, `404 NOT_FOUND` for an unknown event (`EventNotFound`, the existing row in the error table). Unauthenticated and unrate-limited like `/_stats` and `/health`: this project has no auth (handbook), and TB-032 is where limits arrive. The `_admin` prefix is the whole access control; §6 says what an abuser gets.

8. **The report is the DTO**: `{ eventId, tiers: [{ tierId, before: number | null, after: number }], rowsExpired, rowsRecorded, unrecorded: token[] }`. `before: null` is a counter that did not exist (the `FLUSHDB` case). "Drift" is `after − before`, the reader's subtraction, not a field that could disagree with the two numbers.

9. **No new Lua, no new key, no migration, no worker change.** The sweeper keeps trusting the index; reconcile does not rebuild the index (ADR 0005's revisit line stays open — after a `FLUSHDB` the index is empty and the rows that pointed at it are expired by (c), which is the right outcome: those holds are gone).

10. **Could the use case be `GetEventAvailability` plus a write?** No: that use case reads through the cache and merges the live counter; reconcile must do the opposite on both counts. One use case, one public method.

### New or changed ports

```ts
// application/ports/HoldStore.ts
export interface HeldEntry { readonly token: HoldToken; readonly qty: number; readonly expiresAt: Date }
/** Every hold the store's index still counts as held for the tier, expired-but-unswept included. */
held(tierId: TierId): Promise<readonly HeldEntry[]>;
/** Overwrite the live counter; answers the value it replaced, null if there was none. */
rebuild(tierId: TierId, remaining: number): Promise<{ before: number | null }>;

// application/ports/HoldRepository.ts
/** Tokens of the rows still 'active' for the tier — the mirror's first read path (TB-027, off the hot path). */
activeTokens(tierId: TierId): Promise<readonly HoldToken[]>;
```

Fakes: `InMemoryHoldStore.held` (its holds for the tier, expired included), `.rebuild`; `InMemoryHoldRepository.activeTokens`; both stubs gain the rejecting defaults.

### Redis keys

None new, none changed. `rebuild` writes `tier:<id> remaining` — the third writer after `create_hold.lua`/`release_hold.lua`/`sweep_hold.lua` and the seed. ADR 0002's revisit list gets the line.

### Lua scripts

None. Decision 4 is the point: `MULTI`/`EXEC` where two plain commands need to be one unit and no logic runs between them.

### Migrations

None.

---

## 4. Files

| File                                                                                                        | New / Changed | Why                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------- |
| `packages/api/src/application/ports/{HoldStore,HoldRepository}.ts`                                          | Changed       | decisions 5, 6, 4                                              |
| `packages/api/src/application/use-cases/ReconcileEvent.ts`                                                  | New           | decision 1                                                     |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`                                                   | Changed       | `held`, `rebuild`                                              |
| `packages/api/src/infrastructure/postgres/PgHoldRepository.ts`                                              | Changed       | `activeTokens`                                                 |
| `packages/api/src/presentation/dto/admin.ts`, `http/controllers/AdminController.ts`, `http/routes/admin.ts` | New           | decisions 7, 8                                                 |
| `packages/api/src/presentation/http/server.ts`                                                              | Changed       | `admin` dep                                                    |
| `packages/api/src/main/composition.ts`                                                                      | Changed       | the use case over the uncached repository; the controller      |
| `packages/api/test/fakes/{InMemoryHoldStore,InMemoryHoldRepository,stubHoldStore,stubHoldRepository}.ts`    | Changed       | the new methods                                                |
| `packages/api/test/integration/http/support.ts` + the five route tests that build the server                | Changed       | `unusedAdminController()`                                      |
| `packages/api/test/unit/application/use-cases/ReconcileEvent.test.ts`                                       | New           | §5                                                             |
| `packages/api/test/integration/redis/RedisHoldStore.test.ts`, `postgres/PgHoldRepository.test.ts`           | Changed       | `held`, `rebuild`, `activeTokens`                              |
| `packages/api/test/integration/http/admin.test.ts`                                                          | New           | the route                                                      |
| `packages/api/test/integration/main/composition.test.ts`                                                    | Changed       | the Acceptance line and the drift cases through the real stack |
| `docs/adr/0006-reconcile-repairs-the-mirror-first.md`                                                       | New           | decision 1                                                     |
| `docs/adr/{0002,0004,0005}-…`                                                                               | Changed       | one revisit line each                                          |
| `docs/tasks/TB-022-…`, `TB-023-…`, `TB-024-…`, `TB-026-…`                                                   | Changed       | the reconcile follow-ups, closed                               |
| `docs/02-product-delivery-plan.md`                                                                          | Changed       | tracker                                                        |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What it would catch                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Unit        | `ReconcileEventUseCase`: unknown event → `unknown-event`, nothing written; a counter that drifted is overwritten with the computed number and reported with `before`/`after`; a missing counter → `before: null`; an active row whose hold is gone → `expired`, counted in `rowsExpired`, and the recomputation reflects it; a held hold with no row → row saved, `rowsRecorded`, counter counts it; an entry with no hash and no row → `unrecorded`, subtracted from the target; the recomputation is read **after** the row repairs (order pinned); the repository is read, not a cache (the use case cannot tell — pinned in composition instead) | the sequence; each repair; the report   |
| Integration | `RedisHoldStore.held`: lists the tier's entries with qty and expiry, expired ones included, undecodable skipped; `rebuild`: overwrites and answers the previous value, `null` when absent; a value written by `rebuild` is what `reserve` then decrements                                                                                                                                                                                                                                                                                                                                                                                            | the two store methods                   |
| Integration | `PgHoldRepository.activeTokens`: active rows only, this tier only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the row's read path                     |
| Integration | route: `POST /_admin/reconcile/:eventId` → 200 with the report; unknown → 404 `NOT_FOUND`; malformed id → 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the controller's mapping                |
| Integration | **composition, the Acceptance line**: seed; `POST /holds` ×3; `FLUSHDB`; `GET /events/:id` shows the computed count (997, rows active); reconcile → tiers all `before: null`, `rowsExpired: 3`; `GET` shows 1000 and the live counter is 1000; a `POST /holds` works again                                                                                                                                                                                                                                                                                                                                                                           | the rehearsal                           |
| Integration | **composition, artificial drift**: `HSET` General to 500 → reconcile reports `before: 500, after: 1000`, page shows 1000; a row inserted by hand with no hold → expired; a hold written through the store with no row → row appears `active`, counter counts it                                                                                                                                                                                                                                                                                                                                                                                      | reported and corrected, both directions |
| Concurrency | none new — no new inventory decision; the window in decision 2 is a documented gap, not a race a test could close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                         |
| Smoke / E2E | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                         |

**Concurrency:** this task writes the counter, and deliberately not atomically with the write path (decision 2). The assertion that matters is that a `rebuild` followed by reserves behaves like a seeded counter, which the composition case covers.

**How each test will be proven able to fail:** `rebuild` dropped from the use case (drift cases red); the row repairs run after the recomputation (expired-row case red: the counter still subtracts the dead hold); `activeTokens` ignoring the tier (another tier's row expired — red); `held` returning only unexpired entries (the "counts an expired-but-unswept hold" case red); the composition root handing the cached repository to the use case (composition drift case red once the cache is warm); `MULTI` replaced by two awaited commands (no test can see it — the task doc says so).

---

## 6. Risks and failure modes

- **What if Redis is down?** `held` throws (`requireReady`), the request is a 500, nothing written anywhere — the row repairs come after the index read, so Postgres is untouched. Reconcile is the tool for after Redis comes back.
- **What if Postgres is down?** `activeTokens` throws; a 500; the index was read and nothing was written. If it fails between the row repairs and the recomputation, some rows are already `expired`/recorded and the counter is untouched — a second call finishes the job; every step is idempotent.
- **What if a key is evicted under `allkeys-lru`?** This is the task that answers it: the counter → `before: null`, rebuilt; a hold hash with its entry → `unrecorded`, counted as held until the sweeper restores it; an entry without its hash → the row is expired by (c) and the hash's quantity is never restored to the counter — correct, because the rebuilt counter never subtracted it.
- **What if this operation runs twice?** Idempotent by construction: expiring an expired row matches nothing, saving a saved hold throws — so (d) checks the row list first and a duplicate is impossible unless the row was written between (b) and (d) by `CreateHold`, in which case `save` throws the primary key and the request is a 500 that a retry answers cleanly. `rebuild` twice writes the same number.
- **What if it dies halfway through?** Between repairs and rebuild: the rows are better and the counter is as it was — call again. Inside `MULTI`: all or nothing per tier.
- **The window (decision 2):** a reserve between the Postgres read and the `HSET` is overwritten: counter too high by its quantity until the next call. An operator's tool, run when quiet.
- **An abuser calling it in a loop:** every call reads the rows and overwrites the counters with the truth; the harm is the window above, repeated, and the Postgres load (TB-032 rate-limits; TB-013's index keeps each call cheap). No auth is the project's stated condition.

---

## 7. Could Postgres already do this?

This _is_ Postgres doing it. The computed count is the one number this task writes; the endpoint exists only because a second copy of that number lives in Redis for the write path (ADR 0001/0002), and a second copy needs a way back to the first. With one store there is nothing to reconcile — and no sweeper, no index, no seed. The price of the live counter, paid in full here; the thing to learn is how small the escape hatch is once the stores' roles are clear (ADR 0004).

---

## 8. Open questions

None blocking. Decision 1 is the one to argue: a reviewer may read the Scope line narrowly (no mirror repair) — §2 says why that reading leaves the counter wrong forever after a `FLUSHDB`. Decision 2 is the other: whether the window should be closed now with a lock rather than stated and left to TB-031.

---

## 9. Documentation this task will produce

- ☐ ADR — `docs/adr/0006-reconcile-repairs-the-mirror-first.md` — decision 1; one line each in ADR 0002, 0004, 0005
- ☐ Task doc — `docs/tasks/TB-027-reconciliation-endpoint.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
