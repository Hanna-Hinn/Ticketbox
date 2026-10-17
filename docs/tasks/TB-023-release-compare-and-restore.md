# TB-023 — Release with compare-and-restore

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-023 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-023-release-compare-and-restore.md`](../implementation-plans/TB-023-release-compare-and-restore.md)
**Branch / PR:** `feat/TB-023-release-compare-and-restore` · [#27](https://github.com/Hanna-Hinn/Ticketbox/pull/27) (based on #26)
**ADR:** none — the script's header carries the race; ADR 0001 the mechanism

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

Releasing a hold gives its tickets back exactly once: `release_hold.lua` restores the quantity only while the hold key still exists and deletes the key and its index entry in the same step, so a second release — a double click, a retry, a release racing the sweeper, fifty concurrent calls — restores nothing. `RedisHoldStore.release` is implemented over it, and the first write-path route exists: `DELETE /holds/:token` → `200 { released: true | false }`. The smoke suite's `DELETE` todo is a real test now.

---

## How it works

```
RedisHoldStore.release(token)
  HGET hold tierId                      (1 s deadline; null → { released: false }, no script)
  release_hold.lua  KEYS hold, tier, tier:holds   ARGV token, tierId
    EXISTS hold == 0            → -1    nothing to release: expired, swept, released, never issued
    HGET hold tierId ~= ARGV[2] → -1    the keys would name the wrong tier
    EXISTS tier == 0            → -2    no counter to restore into: refuse, warn, reconcile (TB-027)
    qty  = HGET hold qty
    left = HINCRBY tier remaining qty   ← first: the one command that can fail
    DEL hold ; ZREM tier:holds token
    return left
```

The adapter reads the hold's tier before the script because the tier's keys are named after an id that lives inside the hold, and building them in Lua would put the key prefix outside the registry (and, on a cluster, touch undeclared keys). The read and the script are not atomic and need not be: the script's `EXISTS` is the compare, and it also checks the tier it was given is still the hold's. Deleting the key is the receipt, so a transport replay is just a second caller — no guard needed, unlike `create_hold.lua`.

The order inside the script is the lesson this task added to the plan: Redis does not undo a script's earlier writes when a later command raises. `HINCRBY` is the one command here that can fail (a counter that is not an integer, a hold with no `qty`); with the deletes first, a corrupt counter would have taken the tickets and the sweeper's only trace of them. The restore runs first, so an error writes nothing.

### Layers touched

| Layer                                     | What changed                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing                                                                                                                                                                                 |
| L2 `application/**`                       | nothing — `ReleaseHoldUseCase` and the port are TB-020's, unchanged                                                                                                                     |
| L3 `infrastructure/**`, `presentation/**` | `redis/scripts.ts` (second script), `redis/RedisHoldStore.ts` (`release`); `dto/holds.ts`, `http/controllers/HoldController.ts`, `http/routes/holds.ts`, `http/server.ts` (`holds` dep) |
| L4 `main/**`, `worker/**`                 | `composition.ts`: `ReleaseHoldUseCase`, `HoldController`                                                                                                                                |
| repo root                                 | `scripts/lua/release_hold.lua`                                                                                                                                                          |

### Key files

| File                                                                     | What it does                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `scripts/lua/release_hold.lua`                                           | compare-and-restore; its header names the double-credit race and why the restore comes first               |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`                | `release`: the prelude read, the script, the `-1`/`-2` mapping, the warn on a missing counter              |
| `packages/api/src/presentation/http/routes/holds.ts`                     | `DELETE /holds/:token`, `z.uuid()` param, `{ released }` body                                              |
| `packages/api/test/integration/redis/RedisHoldStore.concurrency.test.ts` | 50 concurrent releases of one token, ×10 — the only test reaching the script's compare through the adapter |

### Redis keys introduced

| Key                                                                                             | Type | TTL | Who writes it | Who reads it |
| ----------------------------------------------------------------------------------------------- | ---- | --- | ------------- | ------------ |
| none — `release_hold.lua` is the second writer of `hold(token)`, `tier(id)` and `tierHolds(id)` |      |     |               |              |

### Lua scripts introduced

| Script             | The race it prevents                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release_hold.lua` | two releases of one token each reading the quantity and each adding it back: the tier gains its tickets twice and oversells from the other direction |

---

## 3. Where this diverged from the plan

| Planned                                                                                         | What actually happened                                                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §6 "dies halfway through: inside the script, nowhere"; the script: `DEL` → `ZREM` → `HINCRBY`   | **Wrong.** The reviewer ran it with `remaining = "abc"`: `HINCRBY` raised, the hold and its index entry were already gone, the tickets lost with no trace. Reordered: restore first, then delete. Two tests (non-integer counter; hold with no `qty`) assert nothing is touched                                  | Review Critical. A script's earlier writes survive a later error; "atomic" means no interleaving, not rollback. The same shape TB-022's reviewer taught about replays: the client library and the server both have behaviours the plan did not reason about. |
| The prelude read trusts its answer                                                              | The script also compares the hold's `tierId` with the one it was given, `-1` on mismatch                                                                                                                                                                                                                         | Review Minor, taken: one compare makes the script self-consistent whatever the caller passed.                                                                                                                                                                |
| "100 ms-deadlined" prelude read                                                                 | 1 s — the write-path deadline from TB-022                                                                                                                                                                                                                                                                        | Plan text was wrong; the code was right.                                                                                                                                                                                                                     |
| "Drop the hold `EXISTS` → double-release test red"; "map `-1` to true → unknown-token test red" | Neither went red: every sequential test is answered by the adapter's prelude read before the script runs. Both sabotages were caught only by the direct-script test and the concurrency test. A deterministic `-1` test now stubs the prelude                                                                    | Review Major: the plan's "proven able to fail" column was reasoning, not observation.                                                                                                                                                                        |
| Silent-client test "the prelude read"                                                           | Written for both awaited commands, read and script, after the review noticed it was missing; the script stub has to be set after construction (the constructor's `defineCommand` overwrites it)                                                                                                                  | Omitted in the first commit.                                                                                                                                                                                                                                 |
| The route test's fixture token, a random-looking UUID                                           | The secret scanner flagged it as a high-entropy secret; replaced with `11111111-…-aaaaaaaaaaa1`. The original commit still carries it, so that check stays red until the incident is dismissed or the squash merge drops the commit; a force-push to rewrite the branch was refused by the session's permissions | A test fixture should look like one.                                                                                                                                                                                                                         |

The fake's `release` adds to `?? 0` when a tier has no counter (TB-020 code); the real store now refuses with `-2`. The state is unreachable in the fake (reserve refuses without a counter and nothing un-seeds), so no test can observe the divergence. Left as is, recorded here.

---

## 4. Tests shipped

| Level       | Test file                                                   | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `test/integration/redis/RedisHoldStore.test.ts`             | exact quantity restored, hold and index gone; **twice restores once**; unknown token no-op; expired hold not restored and its index entry kept for the sweeper; counter gone → refused with a warn, hold and index untouched; the script called directly: missing hold `-1`, tier mismatch `-1`, missing counter `-2`, nothing touched; **non-integer counter → throws, nothing touched**; **hold with no `qty` → throws, nothing touched**; prelude stubbed → the adapter's `-1` → `{ released: false }`; not-ready client throws; silent read and silent script reject at 1 s |
| Integration | `test/integration/http/holds.test.ts`                       | `DELETE /holds/<uuid>` with a live hold → `200 { released: true }`, availability back to 10; gone / never issued → `200 { released: false }`; malformed → `400` envelope                                                                                                                                                                                                                                                                                                                                                                                                        |
| Concurrency | `test/integration/redis/RedisHoldStore.concurrency.test.ts` | **50 concurrent releases of one token → exactly 1 `released: true`, counter exactly 10, hold and index gone — ×10**                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Smoke       | `test/smoke/smoke.test.ts`                                  | `DELETE /holds/<unknown uuid>` against the running API → `200 { released: false }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Unit        | —                                                           | none new; the use case is TB-020's and the controller has no branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Final run on `571170e`: typecheck clean, `lint --max-warnings 0` clean, unit **152 passed**, integration **149 passed** (14 files). Smoke against the API restarted on this branch: **5 passed, 1 todo** (`POST /holds`, TB-025).

**Proven able to fail** — nine sabotages, seven by the reviewer on `742b136`, two here on `571170e`, each restored from git:

```
(reviewer, on the release tests)
1  adapter does HGET qty → HINCRBY → DEL → ZREM instead of the script   11 red: missing-counter + concurrency ×10
2  Lua without the hold EXISTS                                          11 red: direct-script + concurrency ×10   (NOT "releasing twice": the prelude answers first)
3  Lua without ZREM                                                     11 red: exact-quantity + concurrency ×10
4  Lua without the counter EXISTS                                        2 red: direct-script + missing-counter
5  HINCRBY qty + 1                                                      12 red: exact-quantity, releasing-twice + concurrency ×10
6  adapter maps -1 to released: true                                    10 red: concurrency ×10 only (NOT unknown-token) → the stubbed-prelude test now covers it
7  route answers 404 on released: false                                  1 red: released-false-still-200
(here)
8  deletes before the restore (the original order)                       2 red: non-integer counter, hold with no qty
9  tier compare removed                                                  1 red: the direct-script test's mismatch case
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran the script with `redis-cli` against a corrupted counter and a hold without `qty` and showed the deletes surviving the error; ran seven sabotages; found two of the plan's "proven able to fail" rows false.
**Verdict:** **NEEDS WORK** (one Critical) → fixed in `571170e` → re-review requested.

| Finding                                                                                   | Severity | Resolution                                                                                      |
| ----------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| The script deletes the hold and its index entry before the one command that can fail      | Critical | Restore first; header and plan §6 corrected; two tests, red under the old order                 |
| Two "proven able to fail" rows false; the adapter's `-1` branch had no deterministic test | Major    | Stubbed-prelude test; concurrency comment says it is the only path through the script's compare |
| Plan text: 100 ms vs 1 s; silent-client test promised, not written; §6 wrong              | Major    | Plan amended; test written for both commands                                                    |
| Header counts the naive release as two commands; `scripts.ts` comment names one command   | Minor    | Both fixed                                                                                      |
| The prelude window: a re-issued token could name the wrong tier                           | Minor    | The script checks the hold's `tierId` against `ARGV[2]`                                         |
| The fake's `?? 0` on release invents a counter                                            | Minor    | Unreachable in the fake; recorded in §3                                                         |

Findings deliberately **not** fixed: the fake's `?? 0` (above).

---

## 6. Failure modes, as built

- **Redis down:** `release` throws before any command (the status guard); `DELETE /holds/:token` is an error, never a false `{ released: false }`.
- **Redis connected but silent:** the read or the script rejects at 1 s; nothing written if it was the read, and if it was the script, the hold may or may not be released — a retry answers honestly either way, because the key is the receipt.
- **Corrupt counter or malformed hold:** the script raises before writing; the hold, its index entry and the counter are untouched; the request is an error (a bug surfaced, not a value).
- **Counter evicted:** `-2`, refused with a warn, the hold untouched until its TTL; reconcile (TB-027) restores the counter. Not `HINCRBY` into a missing hash, which would create a counter of size `qty` and hide the tier from the computed-count fallback.
- **Hold expired, swept or already released:** `-1`, `{ released: false }`, 200. The index entry of an expired hold is left for the sweeper.
- **Runs twice:** the task itself. Deleting the key is the receipt; a transport replay is a second caller.
- **Release racing the sweeper (TB-026):** whichever script runs first wins; the sweeper must be `EXISTS`-first too.
- **A replayed `create_hold` after a release:** pays again; the replay window is a reconnect, a release is seconds later. Accepted (TB-022's follow-up).

---

## 7. What I'd do differently

Think about the error path of every command in a script, not just its happy path, and put the fallible one first. "Atomic" was doing too much work in my head: it means no one else interleaves, not that Redis rolls back. The reviewer found it in two minutes with `redis-cli` and a counter set to `abc`; the plan could have.

---

## 8. Follow-ups left behind

- [x] **Who seeds the live counters** — still open; TB-025's plan must decide (TB-022's follow-up). _TB-025: `pnpm seed`, `HSETNX`._
- [x] TB-025: `POST /holds`, `GET /holds/:token`, `UuidTokenGenerator`; the `z.uuid()` on the token param assumes it. _Done._
- [ ] TB-026: the sweeper's script must be `EXISTS`-first and restore-before-delete, for the same two reasons as this one.
- [ ] The fake's `?? 0` on release; align with `-2` if a test ever needs the state.
- [ ] GitGuardian: incident 38333657 is the fixture UUID in `742b136`; dismiss it or let the squash merge drop the commit.
