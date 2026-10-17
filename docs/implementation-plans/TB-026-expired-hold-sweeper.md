# TB-026 — Expired-hold sweeper

**Status:** Implemented — see [`docs/tasks/TB-026-expired-hold-sweeper.md`](../tasks/TB-026-expired-hold-sweeper.md)
**Date:** 2026-10-17
**Task:** TB-026 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-026-expired-hold-sweeper` (stacked on `feat/TB-025-hold-ui-countdown`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decision 1 is the one to read first**: where the sweeper gets the quantity it restores, which changes the shape of the index TB-022 wrote.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** `ReleaseExpiredHoldsUseCase` in the application layer. A worker running every 5s: `ZRANGEBYSCORE tier:{id}:holds -inf now`, then for each token a Lua script that restores inventory, removes the ZSET member, and marks the Postgres row `expired` — **idempotently**, so running it twice cannot double-restore.

**Acceptance:** create a hold with a 3s TTL, wait 8s, watch availability return on its own.

**Tests:** **unit** — the use case with `FakeClock` and fakes, including "sweeping twice restores once". **Integration** — a real short TTL restores inventory; two sweepers running concurrently restore exactly once.

**Depends on:** TB-023 — confirmed merged: ☐ (stacked: #27 is open, not merged, by the session's instruction; this branch is based on #29 which contains it)

---

## 2. What I understand this to mean

When a hold's key reaches its TTL, Redis drops the hash and **nothing has given the tickets back**: `remaining` was decremented by `create_hold.lua` and stays decremented. The sorted set `tier:<id>:holds` is the index that does not expire; a worker reads from it every 5 s the holds whose expiry is past, and a script restores each one's quantity exactly once — once across two sweepers, once across a sweep racing a late Release, once across a crash and a retry — removing the index entry as the receipt. The mirror row is then marked `expired`, after the restore, never instead of it. The browser learns nothing from this task; E2E-3 (the timer expires and the number comes back by itself) is TB-038's, on top of this.

**One thing the Scope line does not say and the code must answer:** by the time a hold's score is past, the hold hash — the only place `qty` has lived so far — is gone with its TTL. The sweeper cannot restore a quantity it cannot read. Decision 1.

---

## 3. Approach

### Layers touched

| Layer                     | What changes                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`            | nothing — expiry is already `Hold.isExpired(now)`                                                                                                                                                                                                                                                                                          |
| L2 `application/**`       | `ports/HoldStore.ts`: `ExpiredHold`, `expired(now)`, `sweep(hold, now)`; `use-cases/ReleaseExpiredHolds.ts` (new)                                                                                                                                                                                                                          |
| L3 `infrastructure/**`    | `scripts/lua/sweep_hold.lua` (new); `create_hold.lua`, `release_hold.lua`: the index member carries `qty` (decision 1); `redis/holdIndex.ts` (new: encode/decode the member); `redis/keys.ts`: the pattern and the parser for `tier:*:holds`; `redis/scripts.ts`: `sweepHold`; `RedisHoldStore`: `expired` (SCAN + ZRANGEBYSCORE), `sweep` |
| L4 `main/**`, `worker/**` | `composition.ts`: `ReleaseExpiredHoldsUseCase` on `System`; `worker/sweeper.ts` (new, the entry point), `worker/runEvery.ts` (new, the loop); `pnpm dev:worker`                                                                                                                                                                            |

### Decisions this plan is making

1. **The index member carries the quantity: `<token>:<qty>`, score `expiresAt`.** Today the member is the bare token and `qty` lives only in the hold hash, whose TTL is the hold's life — so at the first instant the sweeper is allowed to act (`score ≤ now`), the hash has expired and `qty` with it. Four ways out, one taken:
   - _Read `qty` from the Postgres row._ Rejected by ADR 0004: the sweeper's restore is a write-path inventory decision, and "no write-path decision reads the mirror". A hold with no row (ADR 0004 row 1) would also be unrestorable forever.
   - _Give the hash a grace TTL beyond `expiresAt` and read `qty` from it._ Two definitions of "expired" (the clock's and the key's), the fake and the real store diverging on "cannot release an expired hold", and still a window — a sweeper down longer than the grace loses the quantity.
   - _A second hash `tier:<id>:holdqty { token: qty }`._ One more key per tier that must agree with the index; evicted independently; three scripts touching four keys.
   - **_Put `qty` in the member._** The index is the structure built for the sweeper; it should carry what the sweeper needs. One `ZADD` in `create_hold.lua`, one `ZREM` of the composed member in `release_hold.lua` (it already reads `qty`), a two-line encoder/decoder. Composite members are an ordinary Redis idiom. **This is a change to a key's shape (Reference Impact Analysis, §4):** a hold in flight across the upgrade has a bare-token member the sweeper cannot decode — it removes it, warns, and leaves the quantity to reconciliation (TB-027). **(amended in review: \"cannot decode\" includes a member that decodes but does not re-encode to itself, `tok:02`; the script looks the re-encoded member up, so such an entry would be listed and refused every tick, forever and silently.)** Dev and CI `FLUSHDB`; nothing is deployed. ADR 0005.

2. **`sweep_hold.lua`: the index entry is the receipt.** `ZSCORE` the member: absent → `-1` (already swept, or released — `release_hold.lua` removes the member too); score `> now` → `-3` (the caller handed it an alive hold; refuse, this script's correctness does not depend on its caller); tier counter absent → remove the member and the hash, return `-2` (there is nothing to restore into; the member's quantity is worthless once the counter is gone, reconciliation rebuilds the counter from Postgres and would double-count a later restore); else `HINCRBY` **first** (TB-023's lesson: the one command that can raise runs before the deletes), then `ZREM`, `DEL` (the hash, if TTL lag has left it), return the new remaining. No loop: one script call per expired hold.

3. **The race the script prevents, named in its header:** a late Release and the sweeper, or two sweepers (two worker processes, or one tick overlapping the next), each read "expired, 2 tickets" and each add 2 back — the tier gains its tickets twice and oversells from the other direction. Each script runs to completion before any other command; whichever takes the receipt (the member for the sweeper, the hash for Release — and each removes both) leaves the other with nothing. `ZRANGEBYSCORE` then the script is **not** atomic and need not be: a member that vanished in between is `-1`.

4. **`HoldStore` grows two methods rather than a new port.** `expired(now): Promise<readonly ExpiredHold[]>` with `ExpiredHold = { token, tierId, qty }`; `sweep(hold, now): Promise<{ swept: true; restored: true; remaining: number } | { swept: true; restored: false } | { swept: false }>`. The store already owns the index; a separate `ExpiredHoldIndex` port would be the same adapter under two names. `restored: false` is the counter-missing case: swept (the entry is gone, the row gets `expired`) but nothing added back, and the adapter warns once, as `reserve` does on `-2`.

5. **The store finds its own tiers with `SCAN MATCH tier:*:holds`.** The alternative — tier ids from Postgres — makes restoring Redis inventory depend on Postgres being up, which is the coupling ADR 0004 exists to refuse; and `EventRepository.listUpcoming` would miss holds on an event that has since started. `SCAN` (never `KEYS`, which blocks) may return a key twice or miss one that moved during a rehash; a periodic sweeper tolerates both — a duplicate is a `-1`, a miss is next tick's. The tier id is parsed from the key name by a function in `keys.ts`, the one module that knows the layout. `ZRANGEBYSCORE key -inf now` per key, `now` from the use case's clock, the same clock that set the scores.

6. **The use case restores every expired hold before it worries about any row, and a row it could not mark is a value, not an abort.** `execute(): Promise<{ swept, restored, unmarked: HoldToken[] }>`: `now = clock.now()`; for each expired hold: `sweep`; if swept, `setStatus(token, "expired")` inside a try — the error is collected, the loop continues. Why not rethrow as `ReleaseHold` does: this is a batch, and a Postgres outage must not throttle inventory restoration to one hold per tick (the retry-amplification argument of TB-024 in the other direction). The worker logs `unmarked` at error level with the tokens **(amended in review: with each token's error — a reason collected is not a reason discarded; a `TypeError` in the repository and a dead Postgres must be told apart in the log)**; the rows are `active` for a hold that is gone — exactly the disagreement ADR 0004 row 2 names and TB-027 closes. A Redis error (`expired` or `sweep` throwing) does abort the tick: Redis is the engine being worked, and the next tick retries.

7. **A missing row is tolerated by construction.** `PgHoldRepository.setStatus` is `UPDATE … WHERE token = $1 AND status = 'active'`: a token with no row matches nothing and throws nothing. TB-024's follow-up ("the sweeper's script must tolerate a hold with no row") needs no code; a unit test pins it.

8. **The worker is `src/worker/sweeper.ts`: `compose(config)`, then a loop.** `compose` builds the Fastify app too; the worker never calls `listen`. One composition root, as CLAUDE.md requires ("only `main/composition.ts` may `new` a concrete adapter"); the cost is an unused server object. `runEvery(intervalMs, tick, onError)` in `worker/runEvery.ts`: `setInterval`, a tick still running when the next fires is **skipped** (two overlapping ticks in one process is decision 3's race, handled, but pointless), errors go to `onError` and never unhandled; returns `stop`. Interval **5 000 ms**, a constant — the Scope line says 5 s and nobody has asked for a knob. `SIGTERM`/`SIGINT` stop the loop and `close()` the system, as `server.ts` does.

9. **No new config, no CI change, no E2E.** The acceptance line (3 s TTL, wait 8 s) is a manual check with `HOLD_TTL_MS=3000`, the API, the worker and `curl`, recorded in the task doc with its output. CI does not run the worker yet; the integration tests call the use case directly. E2E-3 is TB-038.

10. **Could the sweeper be a Lua loop sweeping a whole tier in one call?** No: CLAUDE.md rule 12 (short, loop-free; the server is blocked for the script's duration) and the per-hold receipt is what makes two sweepers safe. N expired holds are N scripts, each sub-millisecond.

### New or changed ports

```ts
// application/ports/HoldStore.ts
export interface ExpiredHold {
  readonly token: HoldToken;
  readonly tierId: TierId;
  readonly qty: number;
}
// …
/** Every hold whose expiry is at or before `now`, as the store's index sees them. */
expired(now: Date): Promise<readonly ExpiredHold[]>;
/**
 * Restore an expired hold's quantity exactly once. swept:false — someone
 * else (a late release, another sweeper) already did; restored:false — the
 * tier has no counter to restore into (evicted): the entry is removed and
 * nothing is added back.
 */
sweep(
  hold: ExpiredHold,
  now: Date,
): Promise<
  | { swept: true; restored: true; remaining: number }
  | { swept: true; restored: false }
  | { swept: false }
>;
```

Fakes: `InMemoryHoldStore` keeps expired holds (it already does — `live()` hides them) and gains `expired(now)` (those with `expiresAt ≤ now`) and `sweep` (delete, restore, once); `stubHoldStore` gains the two rejecting defaults.

### Redis keys

None new. **One changed shape:** `ticketbox:v1:tier:<tierId>:holds` zset member `<token>` → `<token>:<qty>` (score unchanged: `expiresAt` ms). `keys.ts` gains `tierHoldsPattern()` (`ticketbox:v1:tier:*:holds`) and `tierIdOfHolds(key): TierId | null`; `holdIndex.ts` gains `encodeMember(token, qty)` / `decodeMember(member)`. Live keys: see decision 1.

### Lua scripts

**`scripts/lua/sweep_hold.lua`** — KEYS: `[1]` tier holds zset, `[2]` tier hash, `[3]` hold hash. ARGV: `[1]` member (`<token>:<qty>`), `[2]` qty, `[3]` now (epoch ms, the use case's clock). Returns the new remaining (`≥ 0`); `-1` nothing to sweep (member gone); `-2` swept but nothing restored (no counter; member and hash removed); `-3` not expired yet (nothing written). Header: the double-restore race (decision 3) and the error ordering (decision 2).

**`create_hold.lua`**: `ZADD KEYS[3] ARGV[5] ARGV[2]..':'..ARGV[1]`. **`release_hold.lua`**: `ZREM KEYS[3] ARGV[1]..':'..qty`. Both headers updated.

### Migrations

None. `holds.status` already admits `expired` (TB-004).

---

## 4. Files

| File                                                                                      | New / Changed | Why                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lua/sweep_hold.lua`                                                              | New           | decisions 2, 3                                                                                                                                                    |
| `scripts/lua/create_hold.lua`, `scripts/lua/release_hold.lua`                             | Changed       | decision 1: the member                                                                                                                                            |
| `packages/api/src/application/ports/HoldStore.ts`                                         | Changed       | decision 4                                                                                                                                                        |
| `packages/api/src/application/use-cases/ReleaseExpiredHolds.ts`                           | New           | decisions 6, 7                                                                                                                                                    |
| `packages/api/src/infrastructure/redis/{keys,scripts,RedisHoldStore}.ts`                  | Changed       | decisions 1, 5; `sweepHold`                                                                                                                                       |
| `packages/api/src/infrastructure/redis/holdIndex.ts`                                      | New           | the member's encoding, in one place                                                                                                                               |
| `packages/api/src/main/composition.ts`                                                    | Changed       | the use case on `System`                                                                                                                                          |
| `packages/api/src/infrastructure/postgres/pool.ts` **(added in review)**                  | Changed       | connection and query timeouts, 5 s: a stalled Postgres must not wedge the sweeper's overlap guard forever (nor an API request). Shared with the API, deliberately |
| `packages/api/src/worker/{sweeper,runEvery}.ts`                                           | New           | decision 8                                                                                                                                                        |
| `package.json`, `packages/api/package.json`                                               | Changed       | `dev:worker`                                                                                                                                                      |
| `packages/api/test/fakes/{InMemoryHoldStore,stubHoldStore}.ts`                            | Changed       | the two methods                                                                                                                                                   |
| `packages/api/test/unit/application/use-cases/ReleaseExpiredHolds.test.ts`                | New           | §5                                                                                                                                                                |
| `packages/api/test/unit/worker/runEvery.test.ts`                                          | New           | §5                                                                                                                                                                |
| `packages/api/test/integration/redis/{RedisHoldStore,RedisHoldStore.concurrency}.test.ts` | Changed       | the member assertion; `expired`, `sweep`, the script's contract; two sweepers                                                                                     |
| `packages/api/test/integration/main/composition.test.ts`                                  | Changed       | the use case wired: a backdated hold is restored and its row marked                                                                                               |
| `docs/adr/0005-the-index-carries-the-quantity.md`                                         | New           | decision 1                                                                                                                                                        |
| `docs/tasks/TB-022-lua-create-hold.md`, `TB-024-…`, `TB-025-…`                            | Changed       | the member's new shape noted; the sweeper follow-ups ticked                                                                                                       |
| `docs/02-product-delivery-plan.md`                                                        | Changed       | tracker                                                                                                                                                           |

**Reference Impact Analysis for the member change** (`grep -rn "zscore\|ZADD\|ZREM\|token → expiresAt"`): `create_hold.lua`, `release_hold.lua`, `keys.ts` comment, `RedisHoldStore.test.ts:64` (`zscore(…, hold.token)`), `docs/tasks/TB-022` key table, `docs/tasks/TB-017` key list. Plans are point-in-time records and stay as written.

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | What it would catch                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Unit        | `ReleaseExpiredHoldsUseCase` with `FakeClock`, `InMemoryHoldStore`, `InMemoryHoldRepository`: restores exactly the expired holds' quantities and leaves alive ones; **sweeping twice restores once**; marks swept rows `expired` and leaves alive rows `active`; a hold with no row is swept and the result still counts it; a row that cannot be marked is reported in `unmarked` and the other holds are still swept; the clock is read once per execute; `swept:false` from the store marks nothing | the use case's sequence; the batch's error isolation |
| Unit        | `runEvery`: ticks on the interval; a tick still running is skipped, not queued; a throwing tick reaches `onError` and the loop continues; `stop` ends it (fake timers)                                                                                                                                                                                                                                                                                                                                 | the loop                                             |
| Integration | `sweep_hold.lua` via `RedisHoldStore.sweep`: restores once and removes member + hash; a second call `swept:false`; an alive hold (score > now) is refused and nothing written; a missing counter → `restored:false`, member removed, nothing added; a non-integer counter → throws with member and counter untouched (error ordering); after `release_hold.lua` ran, sweep is `swept:false`                                                                                                            | the script's contract, each branch                   |
| Integration | `RedisHoldStore.expired(now)`: lists holds at or before `now` across two tiers, none after; a member it cannot decode is removed and warned about                                                                                                                                                                                                                                                                                                                                                      | SCAN + parse + the upgrade case                      |
| Integration | **the real TTL**: reserve with a 50 ms TTL, poll until the hash is gone, `expired(now)` still lists it, `sweep` restores: counter back, index empty                                                                                                                                                                                                                                                                                                                                                    | the whole reason for the index                       |
| Integration | `create_hold.lua` writes the composite member; `release_hold.lua` removes it (updated assertions)                                                                                                                                                                                                                                                                                                                                                                                                      | decision 1 on both scripts                           |
| Concurrency | **two stores sweeping the same 10 expired holds concurrently** (`Promise.all` of both `execute`s, two clients): counter exactly `start + Σqty`, index empty, every row `expired`, ×10 runs                                                                                                                                                                                                                                                                                                             | the double restore                                   |
| Integration | composition: `POST /holds` (row `active`), backdate the member's score and `PEXPIRE` the hash to 1 ms, poll it gone, `system.sweeper.execute()` → `{ swept: 1, restored: 1 }`, page shows 1000, row `expired`                                                                                                                                                                                                                                                                                          | the wiring, both engines                             |
| Smoke / E2E | none — TB-038                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                      |

**Concurrency:** yes, this task touches inventory on the restore side. Exact assertion: 10 expired holds of 1 against a tier at 990; two sweepers at once; final `remaining` **exactly 1000**, 10 rows `expired`, `ZCARD` 0, ten runs.

**How each test will be proven able to fail:** `ZREM` before `HINCRBY` and make the counter non-numeric (ordering test red); drop the `ZSCORE` receipt (concurrency test red: 1010); drop the `score > now` guard (alive-hold test red); `ZREM` instead of `ZADD` of the composite member (member test red, TTL test red); `setStatus` before `sweep` in the use case (unit "marks nothing when swept:false" red); rethrow in the use case (unit "other holds still swept" red); `runEvery` without the overlap guard (unit red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `expired` throws (`requireReady` / the deadline); the tick fails, `onError` logs, the next tick in 5 s retries. Nothing is restored meanwhile; the holds' hashes expire on their own and the counters stay low — the exact leak this task exists to close, bounded by Redis's outage, not the TTL. The row side is untouched.
- **What if Postgres is down? (added in review)** _Refusing_ (`ECONNREFUSED`): `setStatus` rejects at once, the token and the error are collected, every other expired hold is still restored, the rows stay `active` for TB-027. _Stalling_ (a black-holed host, an `UPDATE` behind a row lock): pg's defaults wait forever, so the tick would never settle and `runEvery`'s overlap guard would skip every later tick, silently — the pool now carries `connectionTimeoutMillis` and `query_timeout` of 5 s, so a stall becomes a rejection within the tick, collected like a refusal. The same bound protects an API request from the same stall.
- **What if a key is evicted under `allkeys-lru`?** The **index**: its holds are never swept; their counters stay low until reconciliation (TB-027) rebuilds them — invisible until then, which is the point TB-040 will make. The **counter**: `sweep` answers `restored:false`, the entry is removed, the row marked `expired`, a warn per hold; reconciliation rebuilds the counter from `total − sold − active rows`, which is right precisely because the row was marked. The **hash**: already gone by design; the sweeper never needed it.
- **What if this operation runs twice?** The whole task. Two sweepers, a sweep overlapping a tick, a sweep racing a Release: the member is the receipt and each script removes it; the second actor restores nothing. The use case run twice on the same tick sweeps the second time `swept:false` and marks nothing. `setStatus` twice is `UPDATE … WHERE status = 'active'` matching nothing.
- **What if it dies halfway through?** Between `sweep` and `setStatus`: tickets back, row `active` for a hold that is gone — ADR 0004 row 2, TB-027's `expired`-for-gone-holds. Between `ZRANGEBYSCORE` and the script: nothing written, next tick. Inside the script: Redis runs it to completion or, on an error, has written nothing (decision 2's ordering).
- **A late Release after the sweep:** `release_hold.lua` finds no hash → `released: false` → the row is left as the sweeper set it (`expired`). A Release _before_ the sweep of an expired-by-clock hold whose hash still lingers (TTL lag): Release restores and removes the member; the sweeper finds `-1`. Either way the row ends `released` or `expired`, both final.
- **Clock skew between the API's clock (scores) and the worker's clock (`now`)**: both are `SystemClock` on the same machine in dev; in general a worker behind the API sweeps late, never early — and the script's `score > now` guard refuses an early sweep regardless of who asks.

---

## 7. Could Postgres already do this?

Entirely. With Postgres as the only truth there is no sweeper: availability is `total − sold − SUM(qty) WHERE status = 'active' AND expires_at > now()`, computed on read, and expiry is a predicate rather than an event; a periodic `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at <= now()` would exist only to keep the audit trail tidy. Nothing is restored because nothing was decremented. The sweeper is the price of the live counter (ADR 0001/0002): a decrement that must be matched by an increment, and a TTL that makes a key invisible without telling anyone. We pay it because the counter is what makes the write path one atomic step, and because watching "expiry is not an event" bite is this project's purpose. Said plainly in ADR 0005.

---

## 8. Open questions

None blocking. Decision 1 is the one to argue: a reviewer may prefer the grace-TTL alternative (no index change) or a global `holds:expiry` zset (no `SCAN`). Decision 6 is the other: a batch that reports a dead Postgres as a value rather than throwing.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0005-the-index-carries-the-quantity.md` — decision 1, with the three alternatives
- ☑ Task doc — `docs/tasks/TB-026-expired-hold-sweeper.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task

---

## 10. Amendments after implementation

- **§4 and §6:** `pool.ts` (connection and query timeouts) and the Postgres-down answer, added in review — the plan had answered the outage and missed the stall.
- **Decision 6:** `unmarked` carries each error, not just the token; the worker's tick lives in `worker/sweepOnce.ts` so its logging is testable.
- **Decision 1:** "cannot decode" includes a member that does not re-encode to itself.
- **§4:** `README.md`'s `dev:worker` line now says what the worker is.
- **§5:** the two-sweeper concurrency test uses the in-memory mirror; the row side under a stall is `pool.test.ts`; nine sabotages, all red.
