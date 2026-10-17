# TB-019 — Stampede protection, negative caching, stats

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-019 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-019-stampede-negative-cache-stats` (stacked on `feat/TB-018-cached-event-repository`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Why:** naive cache-aside has a cliff under concurrency.

**Scope:** single-flight — one caller wins a short `SET NX` mutex and refreshes while others wait and re-read. Negative caching of "not found" for 30s. Hit/miss counters via `INCR`, exposed at `GET /_stats`.

**Acceptance:** `BENCHMARKS.md` gains a "cached" row, compared honestly against the **indexed** baseline, not the unindexed one.

**Tests:** **integration** — 50 concurrent requests to a cold key call the inner repository exactly once; an unknown ID hits Postgres once, then serves from the negative cache.

**Depends on:** TB-018 (open, PR #21, the base of this branch) — confirmed: ☑

---

## 2. What I understand this to mean

TB-018's decorator has three gaps that show up only under load or abuse, and this task closes them inside the same file. **Stampede:** fifty concurrent misses on one cold key are fifty Postgres reads and fifty identical `SET`s; after this task, one of them reads and the other forty-nine wait for its answer. **Negative caching:** an unknown id is a Postgres read every time, which is how a scraper or a typo turns into load; after this task, "not found" is cached for 30 s. **Stats:** nobody can see the hit ratio; after this task, `INCR` counters and `GET /_stats` make it visible, and BENCHMARKS §2 uses them.

The acceptance line is the benchmark, and the word that matters is _honestly_: the cached row is compared against the indexed row (23.1 ms / 310.6 req/s / mean 159.6 ms, same machine, same 200 000-row fixture), never against the unindexed one, and "Postgres queries issued" is a number read from Postgres's own statistics, not inferred.

---

## 3. Approach

### Layers touched

| Layer                      | What changes                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L2 `application/`          | New port `CacheStatsReader`; new use case `GetCacheStatsUseCase`                                                                                                        |
| L3 `infrastructure/redis/` | `CachedEventRepository.ts`: single-flight + negative caching + counting; new `RedisCacheStats.ts`; `keys.ts`: mutex, negative sentinel is a value not a key, stats keys |
| L3 `presentation/`         | `GET /_stats` route, `StatsController`, `dto/stats.ts`                                                                                                                  |
| L4 `main/composition.ts`   | Wires the stats adapter into the decorator and the use case into the controller                                                                                         |
| docs                       | `BENCHMARKS.md` §2 filled                                                                                                                                               |

### The decorator, after this task

```
findById(id)
  status !== "ready" → inner (as TB-018)
  GET cache:event:<id>  (deadline)
    hit, value === NEGATIVE_SENTINEL  → stats.recordHit()  → null
    hit, parses                       → stats.recordHit()  → Event
    hit, rejected                     → warn → treat as miss
    miss                              → stats.recordMiss()
      SET cache:event:<id>:refresh <token> NX PX 1000     (deadline)
        won  → inner.findById → SET event JSON EX 300 | SET NEGATIVE_SENTINEL EX 30 → return
        lost → poll GET cache:event:<id> every 10 ms for up to 1000 ms
                 value appears → parse / sentinel → return   (counted as the one miss above, not as a hit)
                 budget spent  → inner.findById → return (the winner died; do not cache — its SET may still land)
  any cache command fails/exceeds the deadline → as a miss, and single-flight is skipped (read through)
```

`RedisCacheStats` (infrastructure): `recordHit()` / `recordMiss()` → `INCR cache:stats:hits|misses`, fire-and-forget under the deadline, failures logged at warn; `read()` → `MGET` both → `{ hits, misses }`. It implements the L2 port `CacheStatsReader { read(): Promise<{ hits: number; misses: number }> }`.

`GetCacheStatsUseCase(stats: CacheStatsReader).execute()` → `{ hits, misses, hitRatio }` with `hitRatio = hits / (hits + misses)`, `0` when both are zero. `StatsController.get()` maps it to `StatsResponse`. `GET /_stats` is unauthenticated like `/health`; it is a learning project with no auth (handbook).

### Decisions this plan is making

1. **The mutex is expiry-only; no release.** `SET cache:event:<id>:refresh <token> NX PX 1000`; the winner does not delete it. Deleting a lock safely needs compare-and-delete (a `DEL` can release someone else's — CLAUDE.md's trap), which is a Lua script, a typed wrapper and an integration test: that is TB-031's lesson ("locking"), not this task's. The cost of not releasing: in the window after a refresh and before the mutex expires (≤ 1 s), a caller that finds the key _missing_ (only possible after an `invalidate`, which nothing calls) cannot win and polls for up to 1 s before reading through. Named here; TB-031 removes it.
2. **Losers poll the cache key, not the mutex.** 10 ms apart, up to the mutex TTL. Polling is a sleep in disguise; the alternative (Pub/Sub on the key, or a `BLPOP` handshake) is a second mechanism for a window that is ~25 ms wide in practice. The budget equals the mutex TTL so a dead winner costs a loser at most 1 s before it reads through itself.
3. **Negative caching is a sentinel value under the same key**, `NEGATIVE_SENTINEL = "null"` (the JSON literal, which the schema can never accept as an event), with `EX 30`. Checked before the Zod step. One key per event keeps the mutex and the read path single; a separate `:missing` key would need its own single-flight.
4. **A loser that waited and found the value counts as the miss it was, not as a hit.** Counters are per _outcome of the first GET_; forty-nine waiters are forty-nine misses that did not touch Postgres. The hit ratio then reads honestly as "how often Redis had the answer when asked".
5. **Counters are fire-and-forget.** An `INCR` failure or timeout must never change a read's result or latency beyond the deadline; it is logged at warn like any other cache command failure.
6. **Stats cross L2 as a port, not a Redis import in `presentation/`.** `CacheStatsReader` is what L2 needs (read two numbers); the recording side is L3-internal (`RedisCacheStats` is handed to the decorator in the composition root). One use case, one `execute`, one controller method, one DTO — the same shape as every other route.
7. **The benchmark re-fills the TB-013 fixture, measures the cached endpoint, and reads "Postgres queries issued" from `pg_stat_user_tables`.** `idx_scan` on `holds` and `order_items` before and after each run is the count of availability sub-queries Postgres actually executed: ~3 per request without the cache (three tiers), ~3 total with it. Hit ratio at steady state from `GET /_stats`. The indexed baseline is TB-013's row, same machine and fixture, two hours earlier — stated, not re-measured, because the composed API now always carries the cache and the plan's own table says "compare against the indexed row above". "Cached, cold" is one miss then hits; it is measured as the first second of the run and said to be that.
8. **The 50-concurrent test uses a deliberately slow inner repository** (an `InMemoryEventRepository` wrapper that counts calls and awaits 50 ms), against real Redis: without the delay the first miss would fill the cache before the second `GET` and the test could pass with no single-flight at all. Run five times in a loop; a concurrency test that passes once proves nothing.

### New or changed ports / Redis keys / Lua scripts

Port: `CacheStatsReader` (L2). Keys: `ticketbox:v1:cache:event:<id>:refresh` (string, the mutex token, PX 1000); `ticketbox:v1:cache:stats:hits`, `…:misses` (integers, no TTL). No Lua (decision 1).

---

## 4. Files

| File                                                                                                                      | New / Changed                                      |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/api/src/application/ports/CacheStatsReader.ts`                                                                  | New                                                |
| `packages/api/src/application/use-cases/GetCacheStats.ts`                                                                 | New                                                |
| `packages/api/src/infrastructure/redis/CachedEventRepository.ts`                                                          | Changed — single-flight, sentinel, counting        |
| `packages/api/src/infrastructure/redis/RedisCacheStats.ts`                                                                | New                                                |
| `packages/api/src/infrastructure/redis/keys.ts`                                                                           | Changed — `eventRefresh`, `cacheStats`             |
| `packages/api/src/presentation/{dto/stats.ts,http/controllers/StatsController.ts,http/routes/stats.ts,http/server.ts}`    | New / changed                                      |
| `packages/api/src/main/composition.ts`                                                                                    | Changed                                            |
| `packages/api/test/fakes/{InMemoryCache.ts,InMemoryCacheStats.ts}`                                                        | Changed / new (the cache fake gains `set … NX PX`) |
| `packages/api/test/unit/{application/use-cases/GetCacheStats.test.ts,infrastructure/redis/CachedEventRepository.test.ts}` | New / changed                                      |
| `packages/api/test/integration/redis/CachedEventRepository.test.ts`                                                       | Changed — the two Tests-line tests, ×5             |
| `packages/api/test/integration/http/stats.test.ts`                                                                        | New                                                |
| `docs/BENCHMARKS.md`                                                                                                      | Changed — §2                                       |

---

## 5. Test plan

| Level       | Test                                                                                                         | What it would catch                            |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Unit        | `GetCacheStats`: ratio from the port's numbers; `0` when both are zero                                       | a division by zero becoming `NaN` in a DTO     |
| Unit        | decorator: a miss records a miss, a hit records a hit, a negative hit records a hit                          | counters wired backwards                       |
| Unit        | decorator: `null` is written as the sentinel with `EX 30` and the next read returns `null` without the inner | negative caching missing or with the wrong TTL |
| Unit        | decorator: a loser whose wait budget expires reads through and does not cache                                | a dead winner stalling everyone forever        |
| Integration | **50 concurrent `findById` on a cold key → inner called exactly once**, ×5                                   | the stampede                                   |
| Integration | **an unknown id → inner called once, then served from the negative cache**                                   | the Tests line                                 |
| Integration | mutex key has `PTTL` ≤ 1000 ms after a refresh; the negative entry has `PTTL` in (25 s, 30 s]                | an immortal mutex; a wrong negative TTL        |
| Integration | `GET /_stats` after a miss and a hit → `{ hits: 1, misses: 1, hitRatio: 0.5 }` through the real composition  | the port, adapter and route not wired          |
| Integration | `/_stats` with Redis down → counters read as `0` and the route still answers (fail-open, like reads)         | a stats page that 500s when the cache is gone  |

**Concurrency:** the 50-concurrent test is the concurrency test; it must be seen red with the single-flight removed before it is trusted.

**How the tests will be proven able to fail:** remove the `SET NX`; make the sentinel TTL 300; swap `recordHit`/`recordMiss`; return `NaN` for an empty ratio.

---

## 6. Risks and failure modes

- **What if Redis is down?** As TB-018: guard, deadline, read through. Single-flight needs Redis; without it the behaviour is TB-018's (every miss reads through) — which is the behaviour before this task, so nothing regresses. Counters are not incremented; `/_stats` reads zeros and says so.
- **What if the winner dies after taking the mutex?** Losers poll for the mutex TTL (1 s), then read through without caching. Nothing waits longer than the mutex lives.
- **What if a key is evicted under `allkeys-lru`?** A miss; single-flight handles the resulting burst. Counters evicted → the ratio restarts from zero, which `/_stats` cannot distinguish from a restart; TB-040 notes it.
- **What if this operation runs twice?** Two concurrent refreshes are the whole point: exactly one wins `NX`.
- **What if it dies halfway through?** Between winning and `SET`: the mutex expires in 1 s; the next miss wins. Between `INCR` and the read: the counter is off by one; it is a statistic.
- **The negative cache lies for 30 s** if an event is created right after a 404 was cached. Events are not created at runtime today; 30 s is the plan's number.
- **The benchmark lies if** the fixture differs from TB-013's (re-filled from the same SQL), the API is not warm (warm-up run), or the "queries issued" number comes from anything but Postgres's own counters.

---

## 7. Could Postgres already do this?

The stampede is a cache problem, so no. The counters could be a Postgres table — and at 300+ `INCR`s per second it would be the wrong table; `INCR` is the right primitive and the lesson. The honest Postgres question is the acceptance line itself: does the cache beat 23 ms / 311 req/s at all? BENCHMARKS §2 answers with numbers, and the ADR 0003 "no cache at all" row says what happens if the answer is no.

---

## 8. Open questions

None blocking. Decision 1 (no release; TB-031's compare-and-delete) is the one a reviewer may want argued the other way.

---

## 9. Documentation this task will produce

- ☐ ADR — none; ADR 0003 covers the pattern, and single-flight is an implementation of it
- ☑ Task doc — `docs/tasks/TB-019-stampede-negative-cache-stats.md`
- ☑ Benchmark entry — `docs/BENCHMARKS.md` §2
- ☐ NOTES entry — not a SPIKE task (TB-019a is next)
