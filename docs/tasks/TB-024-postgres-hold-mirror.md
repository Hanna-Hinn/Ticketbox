# TB-024 — Postgres hold mirror

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-024 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-024-postgres-hold-mirror.md`](../implementation-plans/TB-024-postgres-hold-mirror.md)
**Branch / PR:** `feat/TB-024-postgres-hold-mirror` · [#28](https://github.com/Hanna-Hinn/Ticketbox/pull/28) (based on #27)
**ADR:** [`docs/adr/0004-the-mirror-is-not-the-truth.md`](../adr/0004-the-mirror-is-not-the-truth.md)

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

A hold now leaves a record. `PgHoldRepository` writes the audit row `active` with the hold's own instants and only ever moves a row out of `active`; `CreateHoldUseCase` writes the row after the store has reserved — and gives the tickets back if the row cannot be written; `ReleaseHoldUseCase` marks the row `released` after the store has restored. ADR 0004 says why the row is not the truth and tabulates each way the two stores disagree, what it costs, and who closes it — including the one disagreement that over-reports, which it hands to TB-027 as a constraint.

---

## How it works

```
CreateHold    reserve(hold)                 Redis decides
              save(hold)                    Postgres records  — on failure: release(hold.token), rethrow the save error
ReleaseHold   release(token)                Redis restores
              released → setStatus(token, 'released')   UPDATE … WHERE status = 'active'
```

The row follows the decision and never leads it. Written first, it would record holds the store then refuses; written after, it lags, and the lag is the ADR's table. The row's active rows are what the computed count subtracts (`PgEventRepository`, TB-010), so the fallback number moves with holds and releases, and reconcile (TB-027) has something to rebuild from — with one trap: a hold with no row (the process died between reserve and save, or Postgres was down and the compensating release failed too) makes the computed count **too high** by `qty` for up to 120 s, so reconcile must not rebuild from rows alone while such holds can be alive.

The compensation is the task's reversed decision. The plan said "no compensation; the TTL bounds it". The reviewer pointed out the bound is per request: with Postgres down, every client retry reserves in Redis (which just answered), fails on the row, and locks another `qty` for 120 s — N retries drain the tier with nothing sold. The compensating release is a write to a store that answered a moment ago; its failure case is exactly the no-compensation behaviour; its common case closes the window in the same request. The caller hears the first error, not the second.

### Layers touched

| Layer                                     | What changed                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`                            | nothing — the row's lifecycle is storage-side (TB-007 decision 3)                                      |
| L2 `application/**`                       | `CreateHold`: `save` after reserve, compensating release; `ReleaseHold`: `setStatus` after release     |
| L3 `infrastructure/**`, `presentation/**` | `postgres/PgHoldRepository.ts` (new)                                                                   |
| L4 `main/**`, `worker/**`                 | `composition.ts`: `PgHoldRepository(pool)` into `ReleaseHoldUseCase` (`CreateHold` is wired by TB-025) |
| test fakes                                | `InMemoryHoldRepository` (new): saved once, leaves `active` once                                       |

### Key files

| File                                                           | What it does                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/api/src/infrastructure/postgres/PgHoldRepository.ts` | `INSERT … 'active'` with the entity's instants; `UPDATE … WHERE status = 'active'` |
| `packages/api/src/application/use-cases/CreateHold.ts`         | reserve → save → (on failure) release → rethrow                                    |
| `docs/adr/0004-the-mirror-is-not-the-truth.md`                 | the decision, both sides of the compensation argument, the table of disagreements  |
| `packages/api/test/integration/main/hold-mirror.test.ts`       | both real adapters by hand: key and row agree on status and on the number          |

### Redis keys introduced

| Key  | Type | TTL | Who writes it | Who reads it |
| ---- | ---- | --- | ------------- | ------------ |
| none |      |     |               |              |

### Lua scripts introduced

| Script | The race it prevents |
| ------ | -------------------- |
| none   |                      |

---

## 3. Where this diverged from the plan

| Planned                                                               | What actually happened                                                                                                                                                                             | Why                                                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision 2: no compensating release when the row write fails          | Reversed: `CreateHold` releases the hold when `save` throws and rethrows the first error; two tests (tickets back; the second failure does not replace the first)                                  | Review Major: "≤ 120 s" was per request. Across retries with Postgres down it is the whole tier, locked, with nothing sold. The plan had named this the decision to argue, and lost the argument. |
| ADR: "all four disagreements under-report"                            | Three do. A hold with no row **over-reports** by `qty` for up to 120 s, and anything rebuilt from the rows inherits it. Row 1 and the closing paragraph rewritten; the constraint handed to TB-027 | Review Critical: the ADR contradicted its own table on the one dangerous direction, and TB-027's plan would have been written from it. ADR 0002 had explicitly handed that window to this ADR.    |
| ADR: "nothing on the hot path reads the row"                          | "no write-path decision reads it (the read path's computed fallback does)"                                                                                                                         | Review Minor: `GET /events/:id` reads the active rows whenever the live counter is absent.                                                                                                        |
| §6 said nothing about what the caller sees when `setStatus` throws    | Stated in the ADR and the plan: a 500 for a release that succeeded; a retry answers `released: false`. Tested                                                                                      | Review Major: a contract that was implied.                                                                                                                                                        |
| §4 listed `docs/tasks/TB-007`, `TB-022`, `TB-023` for follow-up ticks | None of them had a TB-024 item; none was touched                                                                                                                                                   | Review Major: the plan listed files it never needed.                                                                                                                                              |
| `hold-mirror.test.ts` with two cases, asserting status                | One case, asserting the number on both sides (998 while held, 1000 after) as well as the status; the "store refuses" case dropped as a unit test re-run over two engines                           | Review Minors.                                                                                                                                                                                    |
| The fake exposing a public `rows` map                                 | Private, with `saved()`, `statusOf()`, `size`                                                                                                                                                      | Review Minor: two read APIs for one fact, and a map a test could mutate.                                                                                                                          |

`test/integration/main/hold-mirror.test.ts` runs no code in `src/main`; it hand-wires two use cases over two engines because the Acceptance line is about two stores agreeing and `POST /holds` does not exist yet. The location is the smell the reviewer named; the follow-up is to fold it into `composition.test.ts` through the routes once TB-025 lands.

---

## 4. Tests shipped

| Level       | Test file                                               | Behaviour asserted                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/application/use-cases/CreateHold.test.ts`    | mirrors the reserved hold as `active`; nothing mirrored on `insufficient`, `InvalidQuantity`; the store is asked before the row is written (order pinned); **a failed row write gives the tickets back and reports that failure; a failed compensation does not replace the first error**                                       |
| Unit        | `test/unit/application/use-cases/ReleaseHold.test.ts`   | marks the row `released` after the store released; leaves it `active` when nothing was released; **a failed `setStatus` rejects with the tickets already back**; `released: false` never touches the mirror, even one that rejects everything                                                                                   |
| Unit        | `test/unit/application/use-cases/HoldLifecycle.test.ts` | create → `active`, release → `released`, a second release leaves it                                                                                                                                                                                                                                                             |
| Integration | `test/integration/postgres/PgHoldRepository.test.ts`    | the row's fields and instants to the millisecond; `released` kept against a later `expired` **and** `expired` kept against a later `released`; the same outcome twice is a no-op; unknown token is a no-op; duplicate token throws; orphan tier throws (foreign key); the computed count moves with the row (1000 → 997 → 1000) |
| Integration | `test/integration/main/hold-mirror.test.ts`             | **both stores**: reserve through the real adapters → key present, row `active`, live 998 and computed 998; release → key gone, row `released`, both 1000                                                                                                                                                                        |
| Concurrency | —                                                       | none new; the inventory decision is the store's (TB-022/023)                                                                                                                                                                                                                                                                    |
| Smoke / E2E | —                                                       | unchanged                                                                                                                                                                                                                                                                                                                       |

Final run on `fccf3a2`: typecheck clean, `lint --max-warnings 0` clean, unit **160 passed**, integration **158 passed** (16 files).

**Proven able to fail** — eight sabotages, six by the reviewer on `2f8f5e9`, two here on `fccf3a2`, each restored from git:

```
(reviewer)
1  save before reserve in CreateHold                 unit: rejects a hold larger than…, asks the store before…; integration: writes no row when the store refuses
2  save on the insufficient path too                 unit: rejects a hold larger than…; integration: writes no row…
3  setStatus without the released guard              unit: leaves the row alone when there was nothing to release   (no integration test red: pinned at unit level)
4  AND status = 'active' dropped from the UPDATE     integration: marks a row released, and keeps that first outcome against a later expired
5  now() instead of the hold's instants              integration: writes the hold as an active row with the hold's own instants
6  setStatus writes 'active'                         integration: marks a row released…, moves the computed count…; hold-mirror
(here)
7  the compensating release removed                  unit: gives the tickets back when the row cannot be written, and reports that failure
8  the compensating release's error allowed to escape  unit: still reports the row's failure when the compensating release fails too
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It verified the SQL's parameter alignment and the timestamptz round-trip, ran six sabotages, read the ADR against its own table and against ADR 0002's hand-off, and reasoned through retries against a down Postgres.
**Verdict:** **NEEDS WORK** (Critical: the ADR said the opposite of its table for the one disagreement that over-sells) → fixed in `fccf3a2` → re-review requested.

| Finding                                                                                     | Severity | Resolution                                                                                     |
| ------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| ADR's closing claim wrong; row 1 over-reports and poisons a rebuild from rows               | Critical | Row 1, the closing paragraph and the TB-027 constraint rewritten; plan §6 too                  |
| "No compensation" under-argued: retries drain the tier                                      | Major    | Decision reversed; compensating release; both sides in the ADR; two tests                      |
| The caller's outcome on a failed `setStatus` unstated                                       | Major    | Stated (500 for a release that happened; retry → `released: false`); tested                    |
| Plan file list named three task docs that had no TB-024 item                                | Major    | Recorded in §3                                                                                 |
| `hold-mirror.test.ts` location; second case a unit test over engines; status but not number | Minor    | Location kept and recorded with the follow-up; case dropped; the number asserted on both sides |
| ADR "hot path" sentence; fake's two read APIs; unused parameter; UPDATE placeholder order   | Minor    | All applied                                                                                    |

Findings deliberately **not** fixed: `hold-mirror.test.ts` stays under `main/` until TB-025 gives `composition.test.ts` the routes to replace it.

---

## 6. Failure modes, as built

- **Redis down:** `reserve` throws before the row is touched (no row); `release` throws before `setStatus` (row stays `active`, correct).
- **Postgres down after a successful reserve:** the hold is released again, the caller gets the mirror's error; only if that release fails too is there a hold with no row — then the TTL and the sweeper, which must tolerate a missing row (TB-026). While such a hold is alive the computed count over-reports by `qty`.
- **Postgres down after a successful release:** the tickets are back, the row stays `active` (nothing in the system marks it until TB-027 expires rows whose hold is gone), the caller gets a 500 for a release that happened, and a retry answers `released: false`. The computed count under-reports by `qty` meanwhile.
- **Key evicted under `allkeys-lru`:** the row stays `active`; reads via the computed fallback keep counting it — under-report.
- **Runs twice:** `save` twice is the primary key throwing (a reused token is a bug); `setStatus` twice matches nothing the second time.
- **Dies halfway:** between `reserve` and `save`, the hold with no row (the compensation never runs) — the over-reporting window; between `release` and `setStatus`, the stale `active` row — under-reporting.

---

## 7. What I'd do differently

Argue the decision I flagged as arguable before writing it down as decided. The plan said "decision 2 is the one to argue" and then wrote an ADR that argued only one side, with a bound ("≤ 120 s") that was true per request and false in aggregate. And read the ADR's table against its own conclusion before calling it finished — the row that over-reports was in the table, and the paragraph under it said the opposite.

---

## 8. Follow-ups left behind

- [x] TB-025: fold `test/integration/main/hold-mirror.test.ts` into `composition.test.ts` through `POST /holds` and `DELETE /holds/:token`, and delete it. Also: **who seeds the live counters** (still open). _Both done: the composition test asserts key and row through the routes; `pnpm seed` writes the counters._
- [x] TB-026: the sweeper's script must tolerate a hold with no row to mark. _It does by construction: `setStatus` matches nothing and throws nothing; pinned by a unit test._ A failed compensating release leaves no log line (its error is swallowed; L2 has no logging port), so "hold with no row" is observable only from the sweeper's side until something in L2 can log.
- [x] TB-027: reconcile must not rebuild the live counter from rows alone while holds with no row can be alive (ADR 0004 row 1), and must expire rows whose hold is gone (row 2). _Both: the index is read and its unrecorded holds subtracted; rows of holds gone from both keys are expired (ADR 0006)._
- [ ] TB-029: the hold's `converted` status belongs in the order's transaction (TB-007 decision 10); ADR 0004's "after Redis" rule then applies to the whole transaction.
