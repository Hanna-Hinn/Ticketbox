# TB-023 — Release with compare-and-restore

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-023 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-023-release-compare-and-restore` (stacked on `feat/TB-022-lua-create-hold`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `release_hold.lua` — only restore if the hold key still exists; delete it and remove it from the ZSET in the same script. `DELETE /holds/:token`.

**Acceptance:** calling release twice restores inventory once.

**Tests:** **integration** — release restores the exact quantity; double release restores once; releasing an unknown token is a no-op returning `{released: false}`; releasing an already-expired hold doesn't restore (the sweeper owns that, per TB-026).

**Depends on:** TB-022 — in the stack below this branch (nothing is merged by the session's instruction): ☑

---

## 2. What I understand this to mean

The obvious release — `HINCRBY` the quantity back, `DEL` the hold — credits inventory every time it is called, and a second call (a double click, a retry, a release racing the sweeper) credits it twice. The fix is the same shape as TB-022's: the check ("does this hold still exist?") and the write ("give its tickets back, delete it, drop it from the index") in one script, so the check cannot go stale between them. Then the first route on the write path: `DELETE /holds/:token`, answering `{ released: true | false }`, through `ReleaseHoldUseCase` (TB-020), which already does exactly one `release` call and nothing else.

---

## 3. Approach

### Layers touched

| Layer                      | What changes                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`             | nothing                                                                                                                                                       |
| L2 `application/**`        | nothing — `ReleaseHoldUseCase` and the port are TB-020's                                                                                                      |
| L3 `infrastructure/redis/` | `scripts.ts` loads and types `release_hold.lua`; `RedisHoldStore.release` implemented                                                                         |
| L3 `presentation/`         | `dto/holds.ts` (`HoldTokenParams`, `ReleaseResponse`), `http/controllers/HoldController.ts`, `http/routes/holds.ts`, `server.ts` gains the `holds` dependency |
| L4 `main/composition.ts`   | `ReleaseHoldUseCase` and `HoldController` wired                                                                                                               |
| repo root                  | `scripts/lua/release_hold.lua`                                                                                                                                |

### The script

```
release_hold.lua
  KEYS[1] hold hash   ticketbox:v1:hold:<token>
  KEYS[2] tier hash   ticketbox:v1:tier:<tierId>
  KEYS[3] tier holds  ticketbox:v1:tier:<tierId>:holds
  ARGV[1] token

  if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end        -- gone: expired, swept, already released, never existed
  if redis.call('EXISTS', KEYS[2]) == 0 then return -2 end        -- no counter to give the tickets back to (decision 3)
  local qty = redis.call('HGET', KEYS[1], 'qty')
  local left = redis.call('HINCRBY', KEYS[2], 'remaining', qty)   -- first: the one command that can fail
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return left
```

Return contract: `≥ 0` the new remaining (released); `-1` nothing to release (nothing written); `-2` the hold exists but its tier has no counter (nothing written).

**The race it prevents (the header comment):** two releases of the same token — a double click, a client retry, a release racing the sweeper — each `HGET` the quantity, each `HINCRBY` it back: the tier gains the tickets twice and sells seats it does not have, from the other direction. Inside the script the existence check and the restore are one step: the second caller finds no key and restores nothing.

### Decisions this plan is making

1. **The adapter reads the hold's tier before the script, and the script re-checks existence.** The script needs the tier hash and the index as `KEYS`, and they are named after the tier id that lives inside the hold hash. Building those names in Lua would put the key prefix in a second place (CLAUDE.md rule 9: every key from the registry) and, on a cluster, touch keys not declared in `KEYS`. So `release` is `HGET hold tierId` (no hold → `{ released: false }` without running the script) then the script with all three keys. The two commands are not atomic, and they do not need to be: the script's `EXISTS` is the compare, and a hold that expires between the read and the script is answered `-1`. The read is a deadlined, fail-closed command like the rest of the write path. _(amended in review: the write-path deadline is 1 s, not the cache's 100 ms; and the script also checks the hold's `tierId` against the one the read returned, so the keys cannot name the wrong tier if a token were ever re-issued in the window.)_
2. **The port and the use case do not change.** `release(token)` → `{ released: true, tierId, remaining } | { released: false }` was specified in TB-020 with the fake, and the script's reply maps onto it exactly: `-1` and `-2` are `{ released: false }`, `≥ 0` carries the tier and the new count.
3. **A hold whose tier has no counter is not released.** `HINCRBY` on a missing hash would create a counter equal to the hold's quantity — a tier of 1 000 reading as 2 — and break the computed-count fallback (ADR 0002) that a missing key triggers. The script returns `-2` without touching anything; the adapter warns naming the tier (the same shape as `reserve`'s `-2`) and reports `{ released: false }`. The hold expires on its own; the counter comes back with TB-027's reconcile. Consistent rule for both writes: no counter → refuse, warn, reconcile.
4. **`DELETE /holds/:token` is `200 { released: boolean }`, never 404.** The Tests line says an unknown token is "a no-op returning `{released: false}`"; the handbook's release semantics are idempotent, and an idempotent delete that 404s the second time is the classic client-side retry trap. The token param is `z.uuid()`: `crypto.randomUUID()` is what the handbook's `UuidTokenGenerator` (TB-025) will produce, and a malformed token is a 400 from the schema, not a store round trip. If TB-025 picks another token shape, this DTO moves with it.
5. **`HoldController` is born with one method.** `POST /holds` and `GET /holds/:token` are TB-025's; adding them now with nothing behind them is speculative. The controller takes `ReleaseHoldUseCase` only.
6. **The smoke test's `DELETE /holds/:token` todo becomes real:** an unknown UUID → `200 { released: false }` against the running API. It needs no seeded counter, which is why it can be the first write-path smoke test.
7. **A concurrency test for the release path**, because every inventory path gets one: 50 concurrent releases of the same token → exactly one `{ released: true }`, the counter restored exactly once, ×10. This is the Acceptance line under contention, not just in sequence.
8. **The counters are still seeded by nobody.** This task's route works without one (it only ever answers `false` until TB-025 can create holds). TB-025's plan must decide who writes `tier:<id> remaining` — the open question carried from TB-022.

### New or changed ports

None.

### Redis keys

None new. `release_hold.lua` is the second writer of `hold(token)`, `tier(id)` and `tierHolds(id)`.

### Lua scripts

`scripts/lua/release_hold.lua` — above.

### Migrations

None.

---

## 4. Files

| File                                                                      | New / Changed | Why                                                                              |
| ------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `scripts/lua/release_hold.lua`                                            | New           | the script, with its header comment                                              |
| `packages/api/src/infrastructure/redis/scripts.ts`                        | Changed       | loads, types and defines `releaseHold`                                           |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`                 | Changed       | `release` implemented (decisions 1, 3)                                           |
| `packages/api/src/presentation/dto/holds.ts`                              | New           | `HoldTokenParams`, `ReleaseResponse`                                             |
| `packages/api/src/presentation/http/controllers/HoldController.ts`        | New           | decision 5                                                                       |
| `packages/api/src/presentation/http/routes/holds.ts`                      | New           | `DELETE /holds/:token`                                                           |
| `packages/api/src/presentation/http/server.ts`                            | Changed       | `ServerDeps.holds`, the route registered                                         |
| `packages/api/src/main/composition.ts`                                    | Changed       | use case + controller wired                                                      |
| `packages/api/test/integration/redis/RedisHoldStore.test.ts`              | Changed       | the release describe (the Tests line, the script's compare, the missing counter) |
| `packages/api/test/integration/redis/RedisHoldStore.concurrency.test.ts`  | Changed       | 50 concurrent releases of one token, ×10                                         |
| `packages/api/test/integration/http/holds.test.ts`                        | New           | the route with the fake store                                                    |
| `packages/api/test/integration/http/{health,events,errors,stats}.test.ts` | Changed       | `holds: unusedHolds` (the dependency is required)                                |
| `packages/api/test/smoke/smoke.test.ts`                                   | Changed       | the `DELETE` todo becomes a test                                                 |
| `docs/tasks/TB-022-lua-create-hold.md`                                    | Changed       | tick the `release_hold.lua` follow-up                                            |

---

## 5. Test plan

| Level       | Test                                                                                                                                                    | What it would catch                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Integration | release restores the exact quantity: 10 → reserve 2 → 8 → release → `{ released: true, tierId, remaining: 10 }`, hold key gone, index member gone       | the Tests line                                                 |
| Integration | **double release restores once**: second call `{ released: false }`, counter still 10                                                                   | the Acceptance line                                            |
| Integration | unknown token → `{ released: false }`, nothing written                                                                                                  | a release that invents inventory                               |
| Integration | expired hold (50 ms TTL, polled): `{ released: false }`, counter still 8, **index member still there** for the sweeper                                  | a release that does the sweeper's job, or deletes its evidence |
| Integration | the script's compare, called directly with a missing hold → `-1` and the counter untouched; with a hold but no counter → `-2`, hold and index untouched | the Lua contract itself (every script gets its own test)       |
| Integration | hold exists, counter evicted → `{ released: false }` + warn naming the tier; hold still there                                                           | decision 3; `HINCRBY` inventing a counter                      |
| Integration | not-ready client → throws; silent client → rejects at the deadline (the prelude read)                                                                   | the write path failing open by accident                        |
| Integration | route: `DELETE /holds/<uuid>` with a hold in the fake → `200 { released: true }`; unknown → `200 { released: false }`; `not-a-uuid` → `400` envelope    | the route, the controller, the DTO                             |
| Concurrency | **50 concurrent releases of one token → exactly 1 `released: true`, counter exactly 10, ×10**                                                           | double credit under contention                                 |
| Smoke       | `DELETE /holds/<unknown uuid>` against the running API → `200 { released: false }`                                                                      | the route not wired                                            |
| Unit        | none new — `ReleaseHoldUseCase` is TB-020's and unchanged; the controller has no branch                                                                 |                                                                |

**Concurrency:** yes, as above; it must be seen red with the script replaced by the naive `HGET` → `HINCRBY` → `DEL` sequence.

**How each test will be proven able to fail:** the naive sequence in the adapter (concurrency and double-release red); drop the `EXISTS` on the hold (double release and the direct-script test red); drop the `ZREM` (index test red); drop the counter check (missing-counter test red: a counter of 2 appears); `HINCRBY` with `qty + 1` (exact-quantity red); map `-1` to `released: true` (unknown-token red); a 404 on `released: false` (route test red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `release` throws (fail closed, like `reserve`); `DELETE /holds/:token` is an error, never a false `{ released: false }`. TB-039 picks the status.
- **What if a key is evicted under `allkeys-lru`?** The hold: `-1`, `{ released: false }`, and its tickets stay held until the sweeper or reconcile — the same as expiry. The counter: `-2`, refused with a warn, hold untouched (decision 3). The index: the release still deletes the hold and restores the counter; `ZREM` on a missing set is a no-op. All three TB-040's.
- **What if this operation runs twice?** That is the task: the second run finds no key and restores nothing. A transport replay (ioredis re-sending after a reconnect, TB-022's lesson) is the same second run — the script is idempotent by construction, no receipt needed, because deleting the key _is_ the receipt.
- **What if it dies halfway through?** _(amended in review — the first answer, "inside the script, nowhere", was wrong)_ A script's earlier writes are not undone when a later command raises. The first draft deleted the hold and its index entry and then ran `HINCRBY`, the one command that can fail (a non-integer counter, a hold with no `qty`): a corrupt counter would have lost the tickets and the sweeper's only trace of them. The restore now runs first, so an error writes nothing. Tested with both corruptions. Between the prelude read and the script, nothing has changed. After the script, before the reply: the hold is released and the caller does not know; a retry answers `{ released: false }`, which is correct — the tickets are back.
- **Release racing the sweeper (TB-026):** both are compare-and-act on the same key; whichever runs first wins, the other restores nothing. The sweeper's script must have the same `EXISTS`-first shape — stated here for TB-026.
- **A replayed `create_hold` after a release** (TB-022's follow-up): the replay finds no receipt and pays again. The replay window is a reconnect; a release is a human seconds later. Accepted, recorded.

---

## 7. Could Postgres already do this?

Yes: `UPDATE holds SET status = 'released' WHERE token = $1 AND status = 'active'` restores once by construction, and the counter would be a column updated in the same statement. We use Redis because the live counter and the hold's TTL live there (TB-022); the compare-and-restore is the Redis spelling of `WHERE status = 'active'`, and the lesson is that it has to be spelled, because `DEL` + `HINCRBY` as two commands is not it.

---

## 8. Open questions

None blocking. Decision 3 (no counter → refuse the release rather than recreate the counter) is the one a reviewer may argue the other way: it leaves a hold a user tried to give back sitting there until its TTL. The alternative puts a wrong number in a tier's counter and hides it from the fallback.

---

## 9. Documentation this task will produce

- ☐ ADR — none; the script's header carries the race, ADR 0001 the mechanism
- ☑ Task doc — `docs/tasks/TB-023-release-compare-and-restore.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
