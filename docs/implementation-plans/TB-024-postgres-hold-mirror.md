# TB-024 — Postgres hold mirror

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-024 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-024-postgres-hold-mirror` (stacked on `feat/TB-023-release-compare-and-restore`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `PgHoldRepository` writing hold rows with status `active | converted | expired | released`. `CreateHoldUseCase` writes to both. **Write an ADR** explaining why the mirror is not the source of truth and what happens when the two disagree.

**Acceptance:** a hold appears in both stores; the ADR exists.

**Tests:** **integration** — creating a hold writes a Postgres row with status `active`; releasing updates it to `released`.

**Depends on:** TB-022 — in the stack below this branch (nothing is merged by the session's instruction): ☑ (and TB-023, for "releasing updates it")

---

## 2. What I understand this to mean

The live hold lives in Redis and dies on its own; nothing in Postgres knows it existed. This task writes the audit row: `CreateHoldUseCase` saves the hold through `HoldRepository` after the store has reserved it, `ReleaseHoldUseCase` marks the row `released` after the store has restored it, and `PgHoldRepository` is the adapter behind the port TB-007 already shaped. The row is a mirror — it follows Redis, never leads it — and the ADR says what that means when they disagree, which they will: the row is written after the reserve, so there is a window with a hold and no row; it is marked after the release, so there is a window with tickets back and a row still `active`.

---

## 3. Approach

### Layers touched

| Layer                         | What changes                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                | nothing — the row's lifecycle is storage-side (TB-007 decision 3); `Hold` has no status                                                                                                        |
| L2 `application/**`           | `CreateHoldUseCase` takes a `HoldRepository` and calls `save(hold)` after a successful reserve; `ReleaseHoldUseCase` takes one and calls `setStatus(token, "released")` after `released: true` |
| L3 `infrastructure/postgres/` | `PgHoldRepository.ts` (new)                                                                                                                                                                    |
| L4 `main/composition.ts`      | `new PgHoldRepository(pool)` into `ReleaseHoldUseCase` (`CreateHoldUseCase` is wired by TB-025's route)                                                                                        |
| test fakes                    | `InMemoryHoldRepository` (new) for the unit tests                                                                                                                                              |
| docs                          | ADR 0004                                                                                                                                                                                       |

### The sequence, as built

```
CreateHold   reserve(hold)              Redis, atomic, the decision
             save(hold)                 Postgres, INSERT … status 'active'       ← after: the row follows the truth
             return

ReleaseHold  release(token)             Redis, compare-and-restore
             released → setStatus(token, 'released')   Postgres, UPDATE … WHERE status = 'active'
             return
```

### Decisions this plan is making

1. **Redis first, Postgres second, no transaction across them.** The store's script is the decision; the row records it. The other order — row first — would record holds the store then refuses, and a row that says `active` for tickets never held under-counts every read that uses the computed number. The window this leaves (hold reserved, row not yet written; tickets restored, row not yet marked) is the ADR's subject, bounded by the TTL on one side and the sweeper (TB-026) on the other.
2. **A mirror failure after a successful reserve is an error to the caller, with no compensation.** If `save` throws, the hold exists in Redis with no row, the request is a 500, and the tickets stay held for ≤ 120 s until the sweeper restores them (its script finds no row to mark; it must tolerate that). A compensating `release` would be a second write that can itself fail, in the same request, to undo a first one — more mechanism for a window the TTL already bounds. Stated in the ADR.
3. **`setStatus` only moves a row out of `active`:** `UPDATE holds SET status = $2 WHERE token = $1 AND status = 'active'`. The audit trail keeps the first outcome; a sweeper marking a released hold `expired` (or the reverse) is a no-op, not a rewrite. A `setStatus` that matches no row (a hold whose `save` failed, or a token never issued) is also a silent no-op at the port — the port returns `void`, and the use case has nothing to do with the answer.
4. **`save` writes `created_at` and `expires_at` from the entity**, not `DEFAULT now()`: the hold's instants come from the use case's `Clock` (TB-022's one-clock rule), and the row should say what the hold says. A duplicate token (primary key) throws: a bug, never a value.
5. **The mirror feeds the computed count.** `PgEventRepository` already subtracts `SUM(qty) WHERE status = 'active'` (TB-010). From this task the fallback number moves when holds are created and released — which is what makes reconcile (TB-027) able to rebuild the live counter from Postgres, and also what makes a stale `active` row an under-count until the sweeper marks it. Said in the ADR.
6. **The "both stores" acceptance test wires the real adapters by hand** in `test/integration/main/hold-mirror.test.ts`: `CreateHoldUseCase(PgEventRepository, RedisHoldStore, FakeClock, FixedTokenGenerator, ttl, PgHoldRepository)` and `ReleaseHoldUseCase(RedisHoldStore, PgHoldRepository)` against both engines. It breaks the "one adapter, one engine" shape of the integration level on purpose, because the Acceptance line is about two stores agreeing; it is one file, under `main/`, where wiring is tested. `composition.test.ts` cannot do it until TB-025 exposes `POST /holds`.
7. **Still nobody seeds the live counters.** The acceptance test seeds `tier:<id> remaining` itself. TB-025 decides.

### New or changed ports

None. `HoldRepository.save(hold)` / `setStatus(token, HoldOutcome)` from TB-007, unchanged. Fake: `InMemoryHoldRepository` with a `rows: Map<HoldToken, { hold, status }>` the tests can read.

### Redis keys

None.

### Lua scripts

None.

### Migrations

None — `holds` exists since TB-004 (`token` primary key, `tier_id` foreign key, `qty > 0`, `status` check, `expires_at`, `created_at`).

---

## 4. Files

| File                                                                                          | New / Changed | Why                                                 |
| --------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------- |
| `packages/api/src/infrastructure/postgres/PgHoldRepository.ts`                                | New           | the adapter                                         |
| `packages/api/src/application/use-cases/CreateHold.ts`                                        | Changed       | `save` after reserve                                |
| `packages/api/src/application/use-cases/ReleaseHold.ts`                                       | Changed       | `setStatus` after release                           |
| `packages/api/src/main/composition.ts`                                                        | Changed       | the repository wired into `ReleaseHoldUseCase`      |
| `packages/api/test/fakes/InMemoryHoldRepository.ts`                                           | New           |                                                     |
| `packages/api/test/unit/application/use-cases/{CreateHold,ReleaseHold,HoldLifecycle}.test.ts` | Changed       | the new constructor argument; the mirror assertions |
| `packages/api/test/integration/http/{holds,events}.test.ts`                                   | Changed       | `ReleaseHoldUseCase`'s new argument                 |
| `packages/api/test/integration/postgres/PgHoldRepository.test.ts`                             | New           | the adapter against Postgres, rolled back per test  |
| `packages/api/test/integration/main/hold-mirror.test.ts`                                      | New           | both stores (decision 6)                            |
| `docs/adr/0004-the-mirror-is-not-the-truth.md`                                                | New           | the Scope line's ADR                                |
| `docs/tasks/TB-007-ports.md`, `TB-022-…`, `TB-023-…`                                          | Changed       | tick the follow-ups this task closes                |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                 | What it would catch                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Unit        | `CreateHold`: saves the hold it reserved (same token, tier, qty, instants) and only after a successful reserve — nothing saved on `insufficient`, `unknown-event`, a thrown quantity | a row for a hold the store refused            |
| Unit        | `CreateHold`: the store is asked before the repository (order pinned with a stub that records the sequence)                                                                          | decision 1 reversed                           |
| Unit        | `ReleaseHold`: marks the row `released` only when the store released; nothing on `released: false`; the store is called before the repository                                        | a row marked released for a hold that was not |
| Unit        | lifecycle: create → row `active`; release → row `released`; a second release leaves it `released`                                                                                    | the Acceptance line, with fakes               |
| Integration | `PgHoldRepository.save`: the row has the token, tier, qty, `active`, and the hold's `expires_at` / `created_at` to the millisecond                                                   | the Tests line                                |
| Integration | `setStatus(token, "released")` → `released`; then `setStatus(token, "expired")` leaves `released`; `setStatus` on an unknown token is a no-op that does not throw                    | decision 3                                    |
| Integration | `save` of a duplicate token throws; `save` for a tier that does not exist throws (the foreign key)                                                                                   | a bug surfacing as a value                    |
| Integration | the mirror moves the computed count: after `save`, `PgEventRepository.findById` shows `remaining` reduced by qty; after `released`, restored                                         | decision 5                                    |
| Integration | **both stores**: create through the real adapters → hold in Redis (`find`) and row `active` in Postgres; release → `released: true`, key gone, row `released`                        | the Acceptance line                           |
| Concurrency | none — the mirror writes one row per hold; the inventory decision is the store's (TB-022/023's tests)                                                                                |                                               |
| Smoke / E2E | unchanged                                                                                                                                                                            |                                               |

**Concurrency:** no inventory path is added; the row's own race (two `setStatus` for one token) is settled by `WHERE status = 'active'` and is sequential by construction in Postgres.

**How each test will be proven able to fail:** `save` before `reserve` (order test red); `save` on every path (insufficient test red); `setStatus` without `released` guard (release test red); drop `AND status = 'active'` (first-outcome test red); write `now()` instead of the hold's instants (instant test red); `setStatus` writes `'active'` (lifecycle red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `reserve` throws before the mirror is touched: no row. `release` throws before `setStatus`: the row stays `active`, correct.
- **What if Postgres is down?** After a successful reserve: a hold with no row, a 500, the tickets held ≤ 120 s, restored by the sweeper, which must tolerate a missing row (TB-026). After a successful release: tickets back, row `active` until… nothing marks it (the sweeper looks at the index, which no longer has the token). **This is the stale-`active` case the ADR must own:** the computed count under-reports by `qty` until reconcile learns to expire rows whose hold is gone (TB-027).
- **What if a key is evicted under `allkeys-lru`?** The mirror does not notice; the row stays `active` until the sweeper or reconcile. Reads via the computed fallback keep counting it — under-report, never over-sell (ADR 0002).
- **What if this operation runs twice?** `save` twice: the primary key throws — a bug (the store already made a replay harmless, so a second `save` can only come from a second request with a reused token, which `TokenGenerator` does not produce). `setStatus` twice: the second matches nothing.
- **What if it dies halfway through?** Between `reserve` and `save`: as Postgres down. Between `release` and `setStatus`: as above. Neither window can over-sell; both can under-report until swept or reconciled.

---

## 7. Could Postgres already do this?

Postgres _is_ this. The question is the reverse one, and it is the ADR: why is the row not the truth? Because the truth has a TTL and is decided under contention in one atomic step, and that is Redis (ADR 0001); Postgres remembers what Redis decided.

---

## 8. Open questions

None blocking. Decision 2 (no compensation when the mirror write fails) is the one to argue: the alternative releases the Redis hold in the same request and turns a 500 into a clean `insufficient`-shaped failure, at the cost of a second write that can fail too.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0004-the-mirror-is-not-the-truth.md`
- ☑ Task doc — `docs/tasks/TB-024-postgres-hold-mirror.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
