# TB-019 — Stampede protection, negative caching, stats

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-019 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-019-stampede-negative-cache-stats.md`](../implementation-plans/TB-019-stampede-negative-cache-stats.md)
**Branch / PR:** `feat/TB-019-stampede-negative-cache-stats` · [#22](https://github.com/Hanna-Hinn/Ticketbox/pull/22) (based on #21)
**ADR:** none new — [`0003-cache-aside-over-write-through.md`](../adr/0003-cache-aside-over-write-through.md) covers the pattern; one sentence of it was corrected by this task

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

Fifty concurrent reads of a cold event key now reach Postgres once, not fifty times: one caller wins a short `SET NX` mutex and refreshes, the others poll the cache key and take the winner's answer. An unknown id is cached as a negative entry for 30 s. Hits and misses are counted in Redis and exposed at `GET /_stats` with a hit ratio. `BENCHMARKS.md` §2 compares the cached endpoint against the indexed baseline, on the same build with Redis stopped as well as against TB-013's row.

---

## How it works

```
findById(id)
  status !== "ready" ───────────────────────────────► inner (as TB-018)
  GET cache:event:<id>                    (100 ms deadline)
    "null"                 → recordHit()  → null
    JSON that parses       → recordHit()  → Event
    JSON that does not     → warn, treat as a miss
    nil / command failed   → recordMiss()
      SET cache:event:<id>:refresh "1" NX PX 1000     (100 ms deadline)
        OK   → inner → SET event JSON EX 300 | SET "null" EX 30 → return
        nil  → look, sleep 10 ms, look … until Date.now() ≥ start + 1000
                 value appears → return it (still the one miss counted above)
                 budget spent  → inner, cache nothing → return
        failed → inner, cache nothing (single-flight skipped)
```

The mutex is never released; it expires. The losers poll the **cache key**, not the mutex, because the winner's `SET` is the thing they are waiting for. The poll budget equals the mutex lifetime, so a winner that dies costs each loser at most 1 s before it reads through itself, and it then caches nothing because the dead winner's `SET` may still land.

The counters are two plain integers (`INCR`, no TTL) written fire-and-forget under the same 100 ms deadline as every other cache command; a failed `INCR` is a warn line, never a slower read. `RedisCacheStats` is one class with two faces: `CacheStatsRecorder` (declared beside `CacheClient` in the decorator, the consumer) and the L2 port `CacheStatsReader` (`MGET` both keys, zeros when Redis is not ready or the command fails). `GetCacheStatsUseCase` turns the two numbers into `{ hits, misses, hitRatio }` with `0`, not `NaN`, before the first lookup.

### Layers touched

| Layer                                     | What changed                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing                                                                                                                                                                                                                                                                                                                                       |
| L2 `application/**`                       | `ports/CacheStatsReader.ts` (new), `use-cases/GetCacheStats.ts` (new)                                                                                                                                                                                                                                                                         |
| L3 `infrastructure/**`, `presentation/**` | `redis/CachedEventRepository.ts` (single-flight, sentinel, counting), `redis/RedisCacheStats.ts` (new), `redis/within.ts` (the deadline helper, extracted), `redis/keys.ts`, `redis/client.ts` (`describeRedisError` exported); `dto/stats.ts`, `http/controllers/StatsController.ts`, `http/routes/stats.ts`, `http/server.ts` (`stats` dep) |
| L4 `main/**`, `worker/**`                 | `composition.ts` wires `RedisCacheStats` into the decorator and the use case into the controller                                                                                                                                                                                                                                              |

### Key files

| File                                                             | What it does                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/api/src/infrastructure/redis/CachedEventRepository.ts` | The decorator: lookup → win-or-wait → write; declares the two seams it needs (`CacheClient`, `CacheStatsRecorder`) |
| `packages/api/src/infrastructure/redis/RedisCacheStats.ts`       | `INCR` on record, `MGET` on read, both bounded; zeros when the client is not ready                                 |
| `packages/api/src/infrastructure/redis/within.ts`                | `within(promise, ms)` and `CACHE_COMMAND_DEADLINE_MS`, shared by the two adapters above                            |
| `packages/api/src/application/use-cases/GetCacheStats.ts`        | The ratio, with the zero guard                                                                                     |
| `packages/api/src/presentation/http/routes/stats.ts`             | `GET /_stats` → `StatsResponse`                                                                                    |

### Redis keys introduced

| Key                                        | Type   | TTL                          | Who writes it                 | Who reads it                 |
| ------------------------------------------ | ------ | ---------------------------- | ----------------------------- | ---------------------------- |
| `ticketbox:v1:cache:event:<id>:refresh`    | string | `PX 1000`, never deleted     | the miss that wins `SET NX`   | nobody — it only gates `NX`  |
| `ticketbox:v1:cache:event:<id>` = `"null"` | string | `EX 30` (the negative entry) | the winner, when inner → null | every lookup, before parsing |
| `ticketbox:v1:cache:stats:hits`            | string | none                         | `INCR` on a hit               | `GET /_stats`                |
| `ticketbox:v1:cache:stats:misses`          | string | none                         | `INCR` on a miss or a failure | `GET /_stats`                |

### Lua scripts introduced

| Script | The race it prevents                                                                              |
| ------ | ------------------------------------------------------------------------------------------------- |
| none   | `SET NX PX` is one command; the compare-and-delete release that would need Lua is TB-031's lesson |

---

## 3. Where this diverged from the plan

| Planned                                                                                        | What actually happened                                                                                                                                                  | Why                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutex value `<token>`                                                                          | The value is `"1"`                                                                                                                                                      | With no release there is nothing that reads a token. The plan's wording was amended.                                                                                                            |
| Miss counted only on a true miss (the §3 diagram)                                              | A failed or timed-out `GET` is counted as a miss too                                                                                                                    | "Redis did not have the answer when asked" is what the ratio reports. The cost: during a Redis stall the `INCR` also times out, so each read logs two warns. Asserted by a unit test.           |
| `CacheStatsRecorder` and the deadline constant would live in the new adapter                   | The recorder interface lives beside `CacheClient` in the decorator; `within` and its constant moved to `within.ts`                                                      | Review Major 1: adapter-declared, it was an import cycle between two L3 modules. The consumer declares its seams.                                                                               |
| `test/integration/http/stats.test.ts` in Phase 2                                               | Delivered in Phase 4                                                                                                                                                    | Forgotten; review Major 5 caught it.                                                                                                                                                            |
| "Indexed (no cache)" = TB-013's row, stated not re-measured                                    | Re-measured on this build with Redis stopped under the running API: 281.2 req/s, p50 176 ms, p99 228 ms, 2 857 Postgres queries for ~2 812 requests. Both columns kept. | Review Major 4: the same build can measure it, and the fail-open path under load had never been measured. It is ~10 % slower than TB-013's row — the guard and reconnect noise are in the path. |
| "Postgres queries issued, cold" = 1                                                            | 2 in the 10 s run; 1 per wave in 5 of 6 repeated 1 s waves, with the loop and readings pasted                                                                           | Review Major 3: `pg_stat_user_tables` flushes with ~1 s lag, and the cell has to say what was measured.                                                                                         |
| Loser sleeps, then looks                                                                       | Looks, then sleeps                                                                                                                                                      | Review Minor 3: the common race is the winner writing between the loser's first `GET` and its `SET NX`; that answer is already there.                                                           |
| Counter tests use `PING` as a barrier                                                          | No ping; the comment names ioredis's FIFO write order on one connection                                                                                                 | Review Minor 5: the ping in the composition test was on a different client than the `INCR`s and could not have been a barrier.                                                                  |
| Post-`invalidate` stall "≤ 1 s", from reasoning                                                | Measured at 1 007 ms by the reviewer, and pinned by a unit test                                                                                                         | So TB-031's compare-and-delete has a test to turn red.                                                                                                                                          |
| The unit tests compared the negative TTL to the constant and expected `{ hits: 2, misses: 2 }` | Literal `30` / `25_000 < pttl ≤ 30_000`, and `{ hits: 3, misses: 2 }`                                                                                                   | Two sabotages (TTL 300; counters swapped) stayed green against the original tests. A test that compares a constant to itself cannot fail.                                                       |

The first attempt at the BENCHMARKS amendment matched §1's table rows as well as §2's and destroyed TB-013's unindexed numbers (`fce650a`); the reviewer caught it and `02a455f` restored §1 byte-for-byte. Third task in a row where a regex-driven docs script rewrote the wrong table; the next docs edit to a table is by line number or by hand.

---

## 4. Tests shipped

| Level       | Test file                                                      | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/application/use-cases/GetCacheStats.test.ts`        | ratio from the counters; `0`, not `NaN`, before the first lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unit        | `test/unit/infrastructure/redis/CachedEventRepository.test.ts` | negative entry written as `"null"` with `EX 30`; miss / hit / negative hit counted (asymmetrically); an unreachable cache counts as a miss; mutex taken with `PX 1000`; a loser takes the winner's answer without touching the inner; a loser whose winner never answers reads through at the mutex lifetime and caches nothing; a loser whose cache breaks mid-wait reads through promptly; when the winner's write fails all three read through once the lifetime is up; a read right after `invalidate` waits out the mutex then reads through uncached |
| Integration | `test/integration/redis/CachedEventRepository.test.ts`         | mutex `PTTL` ≤ 1000; unknown id → inner once, then the negative cache, `PTTL` in (25 s, 30 s]; counters read back `["2", "1"]`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Integration | `test/integration/http/stats.test.ts`                          | `GET /_stats` → `{ cache: { hits: 3, misses: 1, hitRatio: 0.75 } }`; zeros before the first lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Integration | `test/integration/main/composition.test.ts`                    | through the real composition: one miss and one hit → `{ hits: 1, misses: 1, hitRatio: 0.5 }`; with Redis down `/_stats` answers zeros                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Concurrency | `test/integration/redis/CachedEventRepository.test.ts`         | 50 concurrent reads of a cold key → inner exactly once, ×5; 50 concurrent reads of a cold unknown id → inner exactly once and the sentinel present, ×5                                                                                                                                                                                                                                                                                                                                                                                                     |
| Smoke       | —                                                              | unchanged (the TB-013 todo for the cache stays until a hold path exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E2E         | —                                                              | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Final run on `b785abc`: typecheck clean, `lint --max-warnings 0` clean, unit **135 passed**, integration **84 passed** (10.0 s).

**Proven able to fail** — seven sabotages, each restored from git, suites green after:

```
S1  tryToWinRefresh always returns "won"
    × fifty concurrent reads of a cold key … (run 1..5)          expected 50 to be 1
    × fifty concurrent reads of a cold unknown id … (run 1..5)   expected 50 to be 1
    Tests  10 failed | 7 passed (17)
S2  waitForRefresh deadline = Date.now()
    integration: the same 10 red; unit: × as a loser, waits for the winner's answer
    × when the winner's write fails … × a read right after invalidation …   3 failed | 27 passed
S3  recordHit / recordMiss swapped
    first run: only × counts an unreachable cache as a miss + × counts hits and misses in Redis
      → "counts a miss, a hit, and a negative hit" expected 2/2 and could not see the swap; made 3/2
    second run: × counts a miss, a hit, and a negative hit  × counts an unreachable cache as a miss
S4  NEGATIVE_TTL_SECONDS = 300
    first run: 30 passed, 17 passed — every assertion compared the constant to itself
      → literal 30 and (25_000, 30_000] in the tests
    second run: × caches an unknown event as a short-lived negative entry; 6 integration red (pttl 300 000)
S5  sentinel branch deleted from lookup
    × caches an unknown event as a short-lived negative entry   × counts a miss, a hit, and a negative hit
    × fifty concurrent reads of a cold unknown id … (run 1..5)   × reads an unknown id from Postgres once …
S6  hitRatio without the zero guard
    × reports a ratio of zero, not NaN   × answers with a ratio of zero before the first lookup
    × reports Redis down within the health bound … (composition: NaN fails the DTO)
S7  trailing setTimeout removed from waitForRefresh
    the unit run never finished: killed after 120 s. With fake timers Date.now() never moves and the
    loop awaits only resolved promises, so it starves the event loop — vitest's own 5 s timeout
    could not fire. Not a per-test red, but no green either; the sleep is load-bearing.
```

**Known trade-off:** the two stampede tests use a 50 ms inner delay. The reviewer showed they go red with the delay at 0 ms as well (fifty pipelined `GET`s return nil before Postgres answers); the delay stays as a margin against a faster Postgres, and the comment now says that.

**Coverage after this task:** not measured — the gates are TB-042's. Every branch of `CachedEventRepository.ts` and `GetCacheStats.ts` has a unit test; `RedisCacheStats.ts` is integration-only.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran typecheck, lint, both suites and the S1/S2 sabotages itself on each head, measured the post-invalidate stall (1 007 ms), and read the ioredis write path to judge the ping barriers.
**Verdict:** NEEDS WORK (5 Majors, 12 Minors) → fixed → NEEDS WORK (the docs script had destroyed §1 of BENCHMARKS) → fixed by line number → **SAFE TO MERGE** on `02a455f`

| Finding                                                                                            | Severity           | Resolution                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `CacheStatsRecorder` declared in the adapter → import cycle between two L3 modules                 | Major              | Declared beside `CacheClient` in the consumer; `within` extracted to its own module |
| `describe(err)` copied into a second file                                                          | Major              | `describeRedisError(err: unknown)` exported from `client.ts`; both copies deleted   |
| BENCHMARKS cold "queries issued" cell said 1; the measurement gave 2 and the waves were not pasted | Major              | Cell says 2 / 1-per-wave; the loop and six readings pasted verbatim                 |
| "Indexed (no cache)" was a two-hour-old number from another build                                  | Major              | Measured on this build with Redis stopped; second column; both kept                 |
| `stats.test.ts` promised, not delivered                                                            | Major              | Delivered in Phase 4                                                                |
| BENCHMARKS docs commit rewrote §1 and misaligned §2                                                | Critical (round 2) | Restored byte-for-byte; §2 rows given four cells                                    |
| Loser sleeps before it looks; mutex warn lacks the key; ping barriers                              | Minor              | All applied                                                                         |
| `unavailable` counted as a miss — decide and assert                                                | Minor              | Kept; asserted; recorded in §3                                                      |
| Plan says `<token>`; ADR 0003 says a corrupt key for an unknown event never heals                  | Minor              | Both amended in Phase 5                                                             |
| Post-invalidate stall; delayed herd when the winner cannot write; corrupt-entry warn cadence       | Minor              | Pinned by tests (first two); recorded under failure modes (all three)               |
| 50 ms delay comment false as measured                                                              | Minor              | Comment corrected                                                                   |

Findings deliberately **not** fixed: the corrupt-entry warn cadence (~100 lines per loser per second while a winner is slow; bounded, only on an already-corrupt key). `Date.now()` in `waitForRefresh` is L3 and wall-clock on purpose (an iteration count would outlive the mutex under load).

---

## 6. Failure modes, as built

- **Redis down:** reads go straight to Postgres (the `status` guard), nothing is counted, `/_stats` answers zeros. Measured under load in BENCHMARKS §2: 281 req/s, every request one query — the pre-cache shape, ~10 % slower than TB-013's row.
- **Redis hangs (socket alive, no replies):** each read pays the 100 ms deadline on its `GET` and another on its `INCR`, logs two warns, then reads through. Tested with the hanging fake.
- **Winner dies after taking the mutex, or its write fails:** every loser polls for the mutex lifetime and then reads through — 1 s of latency plus the herd the mutex was for, once, bounded. Pinned by the three-reader unit test.
- **A read within 1 s of `invalidate`:** finds no key, cannot win the still-live mutex, polls for ~1 s, reads through uncached. Nothing calls `invalidate` today; TB-031's compare-and-delete release turns the pinning test red.
- **`SET NX` lands after `within` timed it out:** the caller reads through; the mutex lives ≤ 1 s and the next readers poll. Same bound.
- **Key evicted under `allkeys-lru`:** a miss; single-flight absorbs the burst. Evicted counters restart the ratio from zero, indistinguishable from a restart.
- **Operation runs twice:** two concurrent refreshes are the design; exactly one `NX` wins.
- **Dies halfway through:** between winning and `SET`, the mutex expires in 1 s and the next miss wins. Between `INCR` and the read, the counter is off by one — it is a statistic.
- **The negative cache lies for 30 s** if an event is created right after its 404 was cached. No runtime event creation exists.

---

## 7. What I'd do differently

Measure the no-cache column on the same build first, before writing a single cached number — the comparison the acceptance line asks for is between two things measured the same way. And stop editing markdown tables with regex: two of this task's five commits exist to repair the third.

---

## 8. Follow-ups left behind

- [ ] TB-031: release the refresh mutex with a compare-and-delete script; the "read right after invalidation" unit test is the one to turn red.
- [ ] TB-040: evicted counters restart the ratio silently; note it in the eviction experiment.
- [ ] A loser polling a corrupt entry warns every 10 ms for up to 1 s; rate-limit the warn if it ever shows up in a log.
- [ ] TB-042: coverage gates; `RedisCacheStats.ts` has no unit test.
