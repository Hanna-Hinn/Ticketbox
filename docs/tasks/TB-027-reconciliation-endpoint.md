# TB-027 — Reconciliation endpoint

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-027 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-027-reconciliation-endpoint.md`](../implementation-plans/TB-027-reconciliation-endpoint.md)
**Branch / PR:** `feat/TB-027-reconciliation-endpoint` · [#31](https://github.com/Hanna-Hinn/Ticketbox/pull/31) (based on #30)
**ADR:** [`docs/adr/0006-reconcile-repairs-the-mirror-first.md`](../adr/0006-reconcile-repairs-the-mirror-first.md)

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

`POST /_admin/reconcile/:eventId`: the escape hatch for the day the two stores disagree. For every tier of the event it marks `expired` the rows of holds the store no longer has at all, subtracts from the target the holds the store still indexes and the rows never knew, then reads Postgres uncached and overwrites the live counter in one `MULTI`, reporting `before` and `after` per tier. After a `FLUSHDB`, one call restores correct availability and the next hold decrements from it — the Acceptance line, run through the composed system.

---

## How it works

```
POST /_admin/reconcile/:eventId
  findById (Postgres, uncached)                       → the tiers
  per tier
    held     = ZRANGE tier:holds 0 -1                 what the store still owes a restore for
    active   = SELECT token … WHERE status='active'   what the rows say is held
    row ∈ active, ∉ held, hash gone      → UPDATE … 'expired'       a hold gone from both keys
    row ∈ active, ∉ held, hash alive     → nothing                   alive; its entry is simply missing
    entry ∈ held, ∉ active               → unrecorded; qty subtracted from the target
  findById again                                      → the recomputed count, rows repaired
  per tier  MULTI HGET HSET EXEC                      → { before, after }
```

**Only a hold gone from both keys is gone.** The first implementation read "not in the index" as "gone" and expired the row; the reviewer proved it an oversell path with the composed system — `DEL tier:General:holds` after a hold, reconcile, row `expired`, counter 1000 with the hold alive and reservable, and the next call a 500. The index key is one key and the hold hash another; `allkeys-lru` evicts either, and a reserve plus its save can land between the index read and the row read. One `find` per drifted row, off the hot path, closes it: a hash that is alive keeps its row, the recomputation subtracts it, and when the hash dies the next call — hash and entry both gone — expires the row.

**Reconcile reads the index; it does not re-record.** A hold the rows never knew (ADR 0004 row 1) is subtracted from the target by the entry's own quantity and reported; a later release or sweep adds it back through the scripts, and the numbers cancel exactly (proven: hold of 3, row deleted, counter hand-set to 500 → reconcile 997 → `DELETE` → 1000). The first version also wrote the missing row; that bought nothing for the counter and was where every hard failure lived.

**The recomputation never comes from the cache.** `CachedEventRepository` serves `findById` for 300 s; the composition root hands the use case the raw `PgEventRepository` — the one place the system knows there are two. The composition test warms the cache before holding and reconciling, and the sabotage that hands in the cached one goes red.

**`MULTI`/`EXEC`, the non-Lua way.** `HGET` then `HSET` as one unit, no command from anyone else between them, nothing decided in the middle. Isolated, not rolled back: a Redis transaction does not undo a command that succeeded when a later one fails, so the adapter checks both replies. The first transaction in this codebase.

### Layers touched

| Layer                                     | What changed                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`                            | nothing                                                                                                                                                                                                      |
| L2 `application/**`                       | `ports/InventoryRepair.ts` (new: `held`, `find`, `rebuild`); `ports/HoldRepository.ts`: `activeTokens`; `use-cases/ReconcileEvent.ts` (new)                                                                  |
| L3 `infrastructure/**`, `presentation/**` | `RedisHoldStore` implements `InventoryRepair` (`ZRANGE` + decode; `MULTI`); `PgHoldRepository.activeTokens`; `dto/admin.ts`, `controllers/AdminController.ts`, `routes/admin.ts` (new); `server.ts`: `admin` |
| L4 `main/**`                              | `composition.ts`: `pgEvents` named and handed to `ReconcileEventUseCase`; `AdminController`                                                                                                                  |
| test fakes                                | `InMemoryHoldStore`: `held`, `rebuild`, `evictHash`, `evictIndex`; `InMemoryHoldRepository.activeTokens`; `stubHoldRepository`; `unusedAdminController()`                                                    |

### Key files

| File                                                           | What it does                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/api/src/application/use-cases/ReconcileEvent.ts`     | the sequence above; the comment on (c) names the two ways a live hold loses its entry         |
| `packages/api/src/application/ports/InventoryRepair.ts`        | what reconcile needs from the store and nothing the write path needs                          |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`      | `held`, `rebuild` (both transaction replies checked; a non-integer counter reports as absent) |
| `packages/api/src/infrastructure/postgres/PgHoldRepository.ts` | `activeTokens`: the mirror's one read path                                                    |
| `packages/api/src/presentation/http/routes/admin.ts`           | `POST /_admin/reconcile/:eventId`, 200 / 404 / 400, unauthenticated like `/_stats`            |
| `docs/adr/0006-reconcile-repairs-the-mirror-first.md`          | the decision, six alternatives, the TB-029 constraint                                         |

### Redis keys introduced

| Key      | Type | TTL | Who writes it                                                       | Who reads it                             |
| -------- | ---- | --- | ------------------------------------------------------------------- | ---------------------------------------- |
| none new |      |     | `tier:<id> remaining` gains a writer: `rebuild` (`HSET` in `MULTI`) | `tier:<id>:holds` gains a reader: `held` |

### Lua scripts introduced

| Script | The race it prevents                                                         |
| ------ | ---------------------------------------------------------------------------- |
| none   | `MULTI`/`EXEC` instead: two commands, one unit, nothing decided between them |

---

## 3. Where this diverged from the plan

| Planned                                                                                          | What actually happened                                                                                                                                              | Why                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (c): an active row whose token is not in the index is a hold that is gone → `expired`            | …and whose hash is gone too. One `find` per drifted row                                                                                                             | **Review Critical, proven end to end.** The index key is evicted on its own, or a reserve+save lands between the two reads; the row of a live hold was expired, the counter rebuilt without it (oversell), and the next call hit the primary key — a 500 on every call. |
| (d): a held hold with no active row gets its row (`find` → `save`), `rowsRecorded` in the report | Subtracted and reported, never recorded; `rowsRecorded` gone from the output, the controller and the DTO                                                            | Review Major: ADR 0004 asked for the index to be read, not for rows to be written; the write bought nothing for the counter and owned every hard failure (the primary-key tie, the 500 for a non-active row).                                                           |
| `held`, `rebuild` on `HoldStore`; `HeldEntry` with `expiresAt`; `ZRANGE … WITHSCORES`            | `application/ports/InventoryRepair.ts` with `held`, `find`, `rebuild`; `HeldEntry { token, qty }`; `ZRANGE 0 -1`                                                    | Review Majors: `HoldStore` had grown to eight methods for five consumers, a method per task — the symptom of a missing port; nothing read `expiresAt`.                                                                                                                  |
| §6 answered eviction in one sentence and `MULTI` as "all or nothing"                             | §6 rewritten around entry × hash × row, naming the one combination still invisible; "isolated, not rolled back"; three windows in decision 2; the TB-029 constraint | Review Major: the plan described the wrong failure modes, including one that was the Critical.                                                                                                                                                                          |
| §5 listed tests for the removed code                                                             | Corrected before Phase 4 read it                                                                                                                                    | Re-review Major: Phase 4 builds from §5.                                                                                                                                                                                                                                |
| The composition tests shared the holds table across cases                                        | `DELETE FROM holds` in `beforeEach`                                                                                                                                 | Found in Phase 4: a hold left by one case is a row with no hash in the next — exactly what reconcile looks for.                                                                                                                                                         |
| The second `findById` answering `null` → `unknown-event`                                         | A throw ("vanished during reconcile")                                                                                                                               | Review Minor: rows had been written; a 404 would hide a mutation.                                                                                                                                                                                                       |
| `truth` as the uncached repository's name                                                        | `pgEvents`                                                                                                                                                          | Review Minor: ADR 0004 says Redis is the truth about holds.                                                                                                                                                                                                             |

---

## 4. Tests shipped

| Level       | Test file                                                | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `test/unit/application/use-cases/ReconcileEvent.test.ts` | unknown event, nothing written; no drift → no change, reported; a drifted counter overwritten and reported; a missing counter `before: null`; a hold gone from both keys → row expired, no longer subtracted; **a row whose entry is gone but whose hash is alive stays, is subtracted, and a second call agrees**; a hold the rows never knew → `unrecorded`, subtracted, `save` never called (rejecting stub), and the sweeper later lands on the exact number; a hash gone with entry and row kept → nothing changes and the sweeper restores exactly; the recomputation after the repairs; the floor at 0; the second lookup's `null` throws |
| Integration | `test/integration/redis/RedisHoldStore.test.ts`          | `held` lists the tier's entries with qty, expired-but-unswept included, another tier's excluded; an undecodable member skipped and **not** removed; `rebuild` answers the previous value, `null` when absent, `null` for `"3.5"` and still overwrites, throws `WRONGTYPE` with nothing written, and writes a counter `reserve` then decrements; fails fast offline                                                                                                                                                                                                                                                                               |
| Integration | `test/integration/postgres/PgHoldRepository.test.ts`     | `activeTokens`: this tier only, active only; empty for no rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Integration | `test/integration/http/admin.test.ts`                    | 200 with the report; 404 `NOT_FOUND` with the event's message; 400 `VALIDATION` for a non-uuid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Integration | `test/integration/main/composition.test.ts`              | **the Acceptance line**: three holds, `FLUSHDB`, page shows 997, one call → `before: null, after: 1000, rowsExpired: 3`, rows `expired`, page and counter 1000, the next hold decrements to 998; **drift** 500 → 998 with the cache warm; **an evicted index** keeps the row and the count across two calls; **a deleted row** → `unrecorded`, 997, release → 1000; **a hold gone from both keys** → row expired, 998 → 1000                                                                                                                                                                                                                     |
| Concurrency | —                                                        | none new; decision 2's windows are documented, not tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Smoke / E2E | —                                                        | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Final run on `f311770`: typecheck clean, `lint --max-warnings 0` clean, api unit **196**, api integration **219** (18 files).

**Proven able to fail** — seven sabotages, each restored from git; the reviewer's own two reproductions (the oversell, the 997 → 1000 cancel) ran against the composed system before and after the fix:

```
S1  rebuild dropped from the use case              unit "drifted": ×; composition "artificial drift": ×
S2  the find in (c) removed                        unit "entry gone, hash alive": ×; composition "index key was evicted": ×
S3  recomputation read before the row repairs      unit "recomputes after": ×; composition "Acceptance line": ×
S4  activeTokens ignores the tier                  PgHoldRepository "this tier only": ×
S5  held lists only unexpired entries              RedisHoldStore "expired-but-unswept included": ×
S6  the cached repository handed to reconcile      composition "not the cache": ×
S7  unrecorded holds not subtracted                unit "never knew about": ×; composition "never knew about": ×
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It reproduced the Critical through the composed system with a temporary integration test, and the subtract-and-release cancellation after the fix; it read ioredis's `exec()` reply shape for the `MULTI`.
**Verdict:** **NEEDS WORK** (Critical: a row with no entry expired while its hash was alive — an oversell, then a 500) → fixed in `d01461c` → re-reviewed → **SAFE TO MERGE** on the code, with §5 of the plan to correct before Phase 4.

| Finding                                                                                                                                                               | Severity | Resolution                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| "Not in the index" read as "gone": evicted index or reserve+save between the reads → oversell, then duplicate key                                                     | Critical | `find` per drifted row; expire only when the hash is gone too; `evictIndex` on the fake; §6 rewritten |
| Plan §6 / decision 2 described the wrong failure modes; `MULTI` "all or nothing"                                                                                      | Major    | Rewritten around entry × hash × row; three windows; "isolated, not rolled back"; TB-029's constraint  |
| `save` in (d): every hard failure lived there and the plan never said what it bought                                                                                  | Major    | Removed; subtract and report only                                                                     |
| `HoldStore` at eight methods for five consumers                                                                                                                       | Major    | `InventoryRepair` port                                                                                |
| `HeldEntry.expiresAt` had no reader                                                                                                                                   | Major    | Removed; `ZRANGE` without scores                                                                      |
| Only the first `MULTI` reply checked; `truth` as a name; the second `findById`'s `null`; the clamp; three names for one quantity; non-integer counter through the DTO | Minor    | All applied                                                                                           |
| §5 of the plan still described the removed code (re-review)                                                                                                           | Major    | Corrected before Phase 4                                                                              |

Findings deliberately **not** fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** `held` throws at `requireReady`; 500; nothing written anywhere — the row repairs come after the index read.
- **Postgres down:** `activeTokens` throws; 500; the index was read, nothing written. Between the repairs and the rebuild: some rows already `expired`, the counter as it was — a second call finishes; every step is idempotent.
- **Key evicted under `allkeys-lru`**, by combination — the **counter**: `before: null`, rebuilt. _Entry present, hash gone, row active_: nothing changes; the sweeper restores on expiry (tested). _Entry present, no active row_: `unrecorded`, subtracted; release or sweep adds it back (tested, 997 → 1000). _Entry gone, hash alive, row active_: the row stays, subtracted; when the hash dies the next call expires it (tested, two calls). _Entry gone, hash gone, row active_: `expired`, no longer subtracted (tested). _Entry gone, hash alive, no row_: invisible; too high by its quantity until the hash dies — the one window left, bounded by the TTL.
- **Runs twice:** idempotent — `setStatus` matches nothing the second time, nothing is inserted, `rebuild` writes the same number (tested: two calls agree).
- **Dies halfway:** between repairs and rebuild — call again. Inside `MULTI` — isolated, not rolled back; both replies checked; moot for one `HGET` and one `HSET`.
- **The windows (decision 2):** a reserve between the Postgres read and the `HSET` → too high by its quantity until the next call; a release or sweep there → too low. A `TB-029` constraint: consuming a hold's hash and removing its entry must be one step, or every converted-but-unexpired hold is `unrecorded` on every call.
- **An abuser in a loop:** each call rewrites the truth; the harm is the windows above, repeated, plus a `SELECT` per tier and a `find` per drifted row. No auth is the project's stated condition; TB-032 rate-limits.

---

## 7. What I'd do differently

Enumerate the combinations before writing the rule. "Not in the index means gone" was one sentence that sounded like a definition and was two of six cases; the reviewer's table of entry × hash × row is what the plan should have started from. And write down what a write buys before keeping it: the row-writing half of the repair survived planning because it felt thorough, not because anything needed it.

---

## 8. Follow-ups left behind

- [ ] TB-028 (SPIKE): the `FLUSHDB` drill with 20 holds, now with an endpoint to call afterwards; and keyspace notifications.
- [ ] TB-029: consuming a hold's hash and removing its index entry must be one step (ADR 0006); whether a converting hold with no row gets one is TB-029's call.
- [ ] TB-031: the lock that could close decision 2's windows.
- [ ] TB-032: `/_admin/*` is unauthenticated and unlimited; a rate limit is the first fence.
- [ ] The per-tier `find` in step (c) is one round trip per drifted row; measure if an event ever has thousands of drifted rows.
