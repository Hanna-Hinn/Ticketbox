# TB-026 — Expired-hold sweeper

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-026 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-026-expired-hold-sweeper.md`](../implementation-plans/TB-026-expired-hold-sweeper.md)
**Branch / PR:** `feat/TB-026-expired-hold-sweeper` · [#30](https://github.com/Hanna-Hinn/Ticketbox/pull/30) (based on #29)
**ADR:** [`docs/adr/0005-the-index-carries-the-quantity.md`](../adr/0005-the-index-carries-the-quantity.md)

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

An abandoned cart returns its tickets by itself. A worker runs `ReleaseExpiredHoldsUseCase` every five seconds: the store lists every index entry whose expiry is past, `sweep_hold.lua` restores each one's quantity exactly once, and the mirror row is marked `expired` after the restore. To make that possible the index entry now carries the quantity (ADR 0005), because by the time a hold may be swept its hash — and the only copy of `qty` — is gone with the TTL. The Acceptance line was run on the live stack: a hold with a 3 s TTL, availability back at 7.9 s, nobody clicking anything.

---

## How it works

```
create_hold.lua   HINCRBY -qty · HSET hold · PEXPIRE ttl · ZADD tier:holds expiresAt "<token>:<qty>"
                                     │ TTL fires: the hash is gone; the entry is not
worker, every 5 s
  expired(now)    SCAN tier:*:holds → ZRANGEBYSCORE -inf now → decode "<token>:<qty>"
  sweep(entry)    sweep_hold.lua: ZSCORE (the receipt) → score ≤ now? → EXISTS tier?
                                   → HINCRBY +qty (first: the one command that can raise)
                                   → ZREM entry · DEL hash (if lingering) → new remaining
  setStatus       UPDATE holds SET status = 'expired' WHERE token = $1 AND status = 'active'
```

**The entry is the receipt.** Two sweepers (two processes, a tick overlapping the next) and a sweep racing a late Release each read "2 tickets, expired" and would each add 2 back. In the script the lookup and the restore are one step, and whoever removes the entry restores; `release_hold.lua` removes the same entry, so a release and a sweep cannot both pay either. The listing and the script are not atomic and need not be: an entry that vanished in between is `-1`, nothing written.

**The restore runs before the removes** (TB-023's lesson): `HINCRBY` is the one command here that can raise — on a counter that is not an integer — and Redis does not undo a script's earlier writes when a later one fails. An entry removed first would be the sweeper's only trace of the tickets, gone with the error.

**A missing counter is swept without restoring.** `-2`: the entry and the hash are removed, nothing is added back, the adapter warns, and the use case still marks the row `expired`. Reconciliation (TB-027) rebuilds the counter from `total − sold − active rows`, which is right precisely because this row no longer says active; an entry left behind would be restored on top of that rebuild.

**The pass is a batch, and the two engines are isolated.** Every expired hold is swept before any row is worried about; a `setStatus` that fails is collected with its error into `unmarked` and the loop continues, because a Postgres outage must not throttle inventory restoration to one hold per tick. A Redis failure aborts the pass; the next tick retries. And a Postgres that _stalls_ rather than refuses would have pinned the worker's overlap guard forever — so the pool now carries 5 s connection and query timeouts, for the API too.

**The store finds its own tiers.** `SCAN MATCH tier:*:holds` (never `KEYS`), the tier parsed from the key by the registry. A scan may return a key twice or miss one mid-rehash; a duplicate is a `-1`, a miss is next tick's. Tier ids from Postgres would have made restoring Redis inventory depend on Postgres being up.

### Layers touched

| Layer                     | What changed                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`            | nothing                                                                                                                                                                                                                                                                                |
| L2 `application/**`       | `ports/HoldStore.ts`: `ExpiredHold`, `SweepResult`, `expired(now)`, `sweep(hold, now)`; `use-cases/ReleaseExpiredHolds.ts` (new)                                                                                                                                                       |
| L3 `infrastructure/**`    | `scripts/lua/sweep_hold.lua` (new); `create_hold.lua`, `release_hold.lua`: the composite member; `redis/holdIndex.ts` (new); `redis/keys.ts`: `tierHoldsPattern`, `tierIdOfHolds`; `redis/scripts.ts`: `sweepHold`; `RedisHoldStore`: `expired`, `sweep`; `postgres/pool.ts`: timeouts |
| L4 `main/**`, `worker/**` | `composition.ts`: `sweeper` on `System`; `worker/sweeper.ts`, `worker/runEvery.ts`, `worker/sweepOnce.ts` (new); `pnpm dev:worker`                                                                                                                                                     |
| test fakes                | `InMemoryHoldStore`: `expired`, `sweep` (as strict as Redis on the argument); `stubHoldStore`                                                                                                                                                                                          |

### Key files

| File                                                            | What it does                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scripts/lua/sweep_hold.lua`                                    | the once-only restore; the header names the double-restore race and the error ordering                     |
| `packages/api/src/application/use-cases/ReleaseExpiredHolds.ts` | one clock reading; sweep every expired hold; mark after; collect rows that could not be marked, with cause |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`       | `expired`: SCAN + ZRANGEBYSCORE + decode (unreadable entries removed and warned); `sweep`: the script      |
| `packages/api/src/infrastructure/redis/holdIndex.ts`            | `encodeMember` / `decodeMember`, the decoder round-trips before it answers                                 |
| `packages/api/src/infrastructure/postgres/pool.ts`              | `connectionTimeoutMillis` and `query_timeout`, 5 s                                                         |
| `packages/api/src/worker/{sweeper,runEvery,sweepOnce}.ts`       | the entry point; the interval with an overlap skip and `onError`; the tick's logging                       |
| `docs/adr/0005-the-index-carries-the-quantity.md`               | the decision, four alternatives                                                                            |

### Redis keys introduced

| Key                                | Type | TTL  | Who writes it                                                                                                                         | Who reads it                             |
| ---------------------------------- | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| none new                           |      |      |                                                                                                                                       |                                          |
| `ticketbox:v1:tier:<tierId>:holds` | zset | none | **member now `"<token>:<qty>"`**, score `expiresAt`; written by `create_hold.lua`, removed by `release_hold.lua` and `sweep_hold.lua` | `expired()` via `SCAN` + `ZRANGEBYSCORE` |

### Lua scripts introduced

| Script           | The race it prevents                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sweep_hold.lua` | two sweepers, or a sweep and a late release, each reading "expired, qty" and each restoring: the tier oversells from the other side |

---

## 3. Where this diverged from the plan

| Planned                                                                  | What actually happened                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6 answered Redis down, eviction, twice, halfway — and not Postgres down | `pool.ts` gained connection and query timeouts (5 s); §6 gained the line, refusing told apart from stalling                                                                      | **Review Major.** Decision 6's "a Postgres outage must not throttle restores" held for a Postgres that refuses and not for one that stalls: pg waits forever by default, the tick would never settle, and `runEvery`'s overlap guard would skip every later tick without a log line. The fix is shared with the API, deliberately: the same stall would hang a request. |
| `unmarked: HoldToken[]`                                                  | `unmarked: { token, error }[]`; the worker logs one error line per entry with `err`                                                                                              | Review Major: "collected, not thrown" had become "discarded"; a `TypeError` in the repository and a dead Postgres were indistinguishable in the log.                                                                                                                                                                                                                    |
| `decodeMember`: split at the last colon, parse the integer               | …and return `null` unless re-encoding gives the input back                                                                                                                       | Review Major: `tok:02` decodes to `qty 2`, re-encodes to `tok:2`, is not in the index, is refused every tick forever, and never takes the "unreadable, remove" path meant for it.                                                                                                                                                                                       |
| The worker's tick body inline in `sweeper.ts`                            | Extracted to `worker/sweepOnce.ts` with a two-method `SweepLog` type                                                                                                             | The review asked for a test that one error line per unmarked row is logged with its cause; a top-level script cannot be tested. Fastify's logger is not pino's type, hence the small interface.                                                                                                                                                                         |
| `-3` folded into `swept: false`                                          | `-3` warns (tier, token) before answering `swept: false`                                                                                                                         | Review Minor: the port says `swept: false` is "someone else did it"; a refused alive hold is a caller or clock bug and must be visible.                                                                                                                                                                                                                                 |
| `README.md` not in the file list                                         | One line: `pnpm dev:worker` is the sweeper, not "stream consumer"                                                                                                                | The README described a worker that did not exist; this task makes it exist.                                                                                                                                                                                                                                                                                             |
| §5: "two sweepers … every row `expired`" as one integration test         | The concurrency test uses two real stores on two clients and the in-memory mirror; the row side with the real repository is proven separately, with the stall, in `pool.test.ts` | One adapter and one real engine per integration test; the two engines together are the composition test's job, which has its own sweep case.                                                                                                                                                                                                                            |

Everything else landed as planned, including decision 1 — which the reviewer did not contest.

---

## 4. Tests shipped

| Level       | Test file                                                     | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `test/unit/application/use-cases/ReleaseExpiredHolds.test.ts` | restores exactly the expired holds and leaves the alive one; **sweeping twice restores once**; nothing before expiry, everything at the exact instant; rows marked `expired`, the alive row `active`; a hold with no row swept and counted; a row that cannot be marked reported **with the exact error** while the others are still restored; a sweep the store refused marks nothing; `restored: false` still marks; the clock read once; a store failure aborts |
| Unit        | `test/unit/worker/runEvery.test.ts`                           | ticks per interval, never at zero; an overlapping tick is skipped, not queued; a failing tick reaches `onError` and ticking continues; `stop` stops                                                                                                                                                                                                                                                                                                                |
| Unit        | `test/unit/worker/sweepOnce.test.ts`                          | nothing logged for nothing swept; counts at info; one error line per unmarked row with `err`; the sweeper's own failure escapes                                                                                                                                                                                                                                                                                                                                    |
| Unit        | `test/unit/fakes/fakes.test.ts`                               | the fake lists, hides and sweeps once; **as strict as Redis** on a wrong qty or tier; refuses an alive hold                                                                                                                                                                                                                                                                                                                                                        |
| Integration | `test/integration/redis/RedisHoldStore.test.ts` (`expired`)   | lists across two tiers, at the exact instant, none after; **lists a hold whose hash is gone**; removes and warns about a bare token and a `tok:02`; skips and warns about a key the registry cannot parse; fails fast offline                                                                                                                                                                                                                                      |
| Integration | `test/integration/redis/RedisHoldStore.test.ts` (`sweep`)     | restores the exact quantity, removes entry and hash; twice restores once; sweeps a lingering hash; **refuses an alive hold, warns, writes nothing**; a missing counter → swept, not restored, no counter invented, warn; **a non-integer counter throws with nothing touched**; release-then-sweep and sweep-then-release; `EVALSHA` after the first call; `release` removes the composite member                                                                  |
| Concurrency | `test/integration/redis/RedisHoldStore.concurrency.test.ts`   | **two stores on two clients sweeping the same 10 expired holds via `Promise.all`: restored 10 between them, counter exactly 1000, index empty, every row `expired` — ten runs**                                                                                                                                                                                                                                                                                    |
| Integration | `test/integration/postgres/pool.test.ts`                      | a query behind `LOCK TABLE … ACCESS EXCLUSIVE` rejects "Query read timeout" within the bound; a connection it cannot get rejects within the bound; the use case over the fake store and the real bounded repository restores both holds and reports both rows with the timeout error                                                                                                                                                                               |
| Integration | `test/integration/main/composition.test.ts`                   | `POST /holds`, the entry backdated and the hash expired, `system.sweeper.execute()` → `{ swept: 1, restored: 1, unmarked: [] }`, the page shows 1000, the row says `expired`, the index is empty                                                                                                                                                                                                                                                                   |
| Smoke / E2E | —                                                             | none; E2E-3 is TB-038                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Final run on `6c28f28`: typecheck clean, `lint --max-warnings 0` clean, api unit **184**, api integration **201** (17 files). The pool test runs its three stalls in 1.1 s against a 200 ms bound.

**The Acceptance line, on the live stack** (`HOLD_TTL_MS=3000`, API and worker started from this branch, counters seeded):

```
t=0  before:   General remaining = 1000
POST /holds -> 998 remaining, expiresAt 2026-10-17T20:38:46.461Z
t=0  after:    General remaining = 998
t=7.9s  back:  General remaining = 1000
--- worker log:
{'swept': 1, 'restored': 1, 'unmarked': 0, 'msg': 'swept expired holds'}
```

**Proven able to fail** — nine sabotages, each restored from git:

```
S1  ZREM before HINCRBY in sweep_hold.lua            "throws on a counter that is not an integer, and has touched nothing": ×
S2  the ZSCORE receipt dropped (always restore)      two sweepers: × on every run; "sweeping twice restores once": ×
S3  the score > now guard dropped                    "refuses a hold that is not expired yet": ×
S4  create_hold.lua writes a bare token member       "the index is what outlives the hold": ×; "writes the hold and its index entry": ×
S5  setStatus regardless of swept                    "never marks a row the store did not sweep": ×
S6  the use case rethrows a setStatus error          "reports a row it could not mark … still sweeps the others": ×
S7  runEvery without the overlap guard               "skips a tick while the previous one is still running": ×
S8  decodeMember without the round-trip check        "removes an entry it cannot read, warns once": ×
S9  the pool without query_timeout                   "rejects a query blocked behind a lock within the bound": Test timed out in 3000ms
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran the script by hand against DB 9 (error ordering, `-3`, the inclusive boundary, the second call), read `pg@8.23.1`'s source to confirm that a `query_timeout` destroys the socket so a blocked `UPDATE` is abandoned rather than handed out again, and re-verified every finding on the fix commit.
**Verdict:** SAFE TO MERGE (no Critical; three Majors) → fixed in `2677c41` → re-reviewed → **SAFE TO MERGE**, three cosmetic notes.

| Finding                                                                                                                                 | Severity | Resolution                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A stalled Postgres wedges the sweeper permanently and silently; §6 had no Postgres answer                                               | Major    | Pool bounded (5 s connection and query); §6 line; proven with a 200 ms bound and a table lock                                                                            |
| `setStatus`'s error dropped; `unmarked` says _that_, never _why_                                                                        | Major    | `{ token, error }`; one error line per entry with `err`                                                                                                                  |
| A member that decodes but does not round-trip is retried every tick forever, silently                                                   | Major    | The decoder re-encodes and compares                                                                                                                                      |
| `-3` silent; `requireReady` message; regex re-spelling the prefix; `SweepResult` alias; fake leniency; header spacing; shutdown comment | Minor    | All applied                                                                                                                                                              |
| `log.info(result, …)` serialising errors at info; "within the tick" is 5 s per row; `DEFAULT_POOL_TIMEOUTS` export (re-review)          | Minor    | Counts logged, not the result; the clause is in §6 below; the export stays (the test imports `createPool` with its own timeouts; the constant is the documented default) |

Findings deliberately **not** fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** `expired` throws at `requireReady` or the deadline; the tick fails, "sweep failed; retrying next tick" at error level, the next tick in 5 s retries. Nothing is restored meanwhile; the counters stay low for as long as Redis is away. Not tested in the loop; the adapter's fail-fast is.
- **Postgres refusing:** `setStatus` rejects at once, every expired hold is still restored, the tokens and the errors are in `unmarked` and the log, the rows stay `active` for TB-027. **Postgres stalling:** each stalled row costs the pass one bound — 5 s _per row, sequentially_, so a pass with N rows behind one lock takes up to 5N s, with ticks skipped meanwhile, then reports them all. Bounded and logged; tested with a 200 ms bound.
- **Key evicted under `allkeys-lru`:** the **index** — its holds are never swept and their counters stay low until reconciliation; silent, which is TB-040's point. The **counter** — `swept: true, restored: false`, entry removed, row `expired`, a warn per hold; reconciliation rebuilds it. The **hash** — already gone by design.
- **Runs twice:** the entry is the receipt. Two sweepers: tested ten times. A sweep racing a release: tested in both orders. The use case twice: `swept: 0` the second time. `setStatus` twice: `WHERE status = 'active'` matches nothing.
- **Dies halfway:** between the script and `setStatus` — tickets back, row `active` for a hold that is gone (ADR 0004 row 2, TB-027). Between the listing and the script — nothing written. Inside the script — run to completion, or nothing written on an error (the restore is the first write).
- **A worker clock behind the API's:** sweeps late, never early; ahead — the script's guard refuses an early sweep and the adapter warns.
- **A hold from before this task** (bare-token member): removed, warned, its quantity left to reconciliation.

---

## 7. What I'd do differently

Ask "and what if it _hangs_?" alongside "what if it's _down_?" — the plan answered the outage and missed the stall, and the stall was the one that would have been silent. And write the pool bound as a system property from the start rather than discovering it through the worker: the API had the same hole since TB-010.

---

## 8. Follow-ups left behind

- [x] TB-027: reconciliation rebuilds the counter from `total − sold − active rows`; it must also expire rows whose hold is gone (ADR 0004 row 2, now produced by every `unmarked` entry), and decide whether it clears or rebuilds the index too (ADR 0005's revisit line). _Done; it trusts the index and does not rebuild it (ADR 0006)._
- [x] TB-028a: E2E-3 — the timer runs out in the browser and the number comes back; needs the worker in the E2E stack and a short `HOLD_TTL_MS`. _Done; CI runs the worker with an 8 s TTL on the API._
- [ ] TB-040: evict the index under `allkeys-lru` and watch the counters stay low; `keys.tierHoldsPattern()` is now the registry's first pattern.
- [x] The sweeper does not run in CI; nothing there needs it until E2E-3. _It does now (TB-028a), PID-checked after the health gate._
- [ ] `worker/sweeper.ts` composes the Fastify app it never listens on; harmless, and the price of one composition root.
