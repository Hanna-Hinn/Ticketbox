# Notes

Write-ups from the spike tasks — the ones in `02-product-delivery-plan.md` marked **not merged**. These produce no code, only understanding, so this file is where that understanding gets kept.

Each entry: what you did, what you expected, what actually happened, and what it changed about how you think about the problem. A few honest sentences beat a polished paragraph — this file is for you, six months from now, more than for anyone else.

---

## TB-019a — Cache invalidation failures

**Task:** comment out cache invalidation, update an event's name directly in `psql`, watch the API serve stale data. Then refresh a cached key with plain `SET` (no `EX`) and check `TTL`.

**Date:** 2026-10-17, on the TB-019 code (branch `spike/TB-019a-cache-invalidation-failures`, nothing but this file changed). Local Postgres 16 and Redis 7.0.15, the API started with `tsx src/main/server.ts`.

**What I did:** there was nothing to comment out. `CachedEventRepository.invalidate` exists since TB-018 and has no caller — no write path exists yet — so the stale window is the system's normal behaviour, not something I had to break. Part 1: deleted the jazz event's key, warmed it through `GET /events/:id` (TTL 300), ran `update events set name = '… (RENAMED IN PSQL)'` in psql, and polled the API and `TTL` every 10 s. Part 2: on the comedy event, warmed the key, then `SET` the same value back with no `EX`, read `TTL`, renamed the event in psql, read the API; then `EXPIRE`, `SET … KEEPTTL`, plain `SET` again, `DEL`. Part 2b (unplanned, after the first `DEL` surprised me): timed the read that follows a `DEL` issued while the refresh mutex from the last refill is still alive.

**What I expected** (written before running, in the scratchpad plan): the API serves the old name for as long as the key had left to live at the moment of the `UPDATE` — ~300 s since I had just warmed it — then the first read after expiry refills with the new name, and nothing in the system notices the `UPDATE` because Postgres cannot tell Redis anything. For part 2: `TTL` becomes `-1`, the key never expires, the rename is never seen until something deletes the key; `KEEPTTL` probably preserves the TTL (Redis 6+, to be confirmed by running it).

**What actually happened:**

```
17:52:40 warm: api name = Rooftop Jazz Night  ttl=300
Rooftop Jazz Night (RENAMED IN PSQL)
UPDATE 1
17:52:40 after update: postgres name = Rooftop Jazz Night (RENAMED IN PSQL)  ttl=300
17:52:40 t+0s api name = Rooftop Jazz Night  ttl=300
17:54:41 t+121s api name = Rooftop Jazz Night  ttl=179
17:55:41 t+181s api name = Rooftop Jazz Night  ttl=119
17:56:41 t+241s api name = Rooftop Jazz Night  ttl=59
17:57:22 t+282s api name = Rooftop Jazz Night  ttl=18
17:57:32 t+292s api name = Rooftop Jazz Night  ttl=8
17:57:42 t+302s api name = Rooftop Jazz Night (RENAMED IN PSQL)  ttl=300
17:57:42 stale window over after 302 s
```

The API served the old name for **302 s** — 31 polls — while Postgres had the new one the whole time. The read at t+302 s found the key gone, refilled it (TTL back to 300) and returned the new name. Nobody told Redis anything; the TTL is the only invalidation this system has.

Part 2, the immortal key:

```
1. warm through the API:        name=Late Night Comedy   TTL=300
2. SET same value, no EX:       reply=OK   TTL=-1
3. rename in psql, read API:    name=Late Night Comedy   TTL=-1   (postgres says: Late Night Comedy (RENAMED IN PSQL))
4. EXPIRE 300 by hand:          reply=1   TTL=300
5. SET same value KEEPTTL:      reply=OK   TTL=300
6. SET same value, no EX again: reply=OK   TTL=-1
7. the counters, for contrast:  hits TTL=-1  misses TTL=-1  (never had one; INCR does not add one either)
8. DEL the immortal key:        deleted=1   next API read: name=Late Night Comedy (RENAMED IN PSQL)   TTL=-2
```

Step 2 is the handbook's trap exactly as described: `SET` on an existing key without `EX` replaced the value **and dropped the TTL** — `300` → `-1`. Step 3 is the consequence: the rename in Postgres is invisible, and unlike part 1 it would stay invisible forever — not for 300 s. `EXPIRE` puts a TTL back; `SET … KEEPTTL` (step 5) keeps it, so it is the right spelling for a refresh that must not touch expiry; a plain `SET` (step 6) drops it again, every time. Step 7: the two stats counters have no TTL by design, and `INCR` is in the family that leaves a TTL alone either way. Step 8: after `DEL`, the next read showed the new name — but did **not** leave a key behind (`TTL -2`), which led to part 2b.

Part 2b, the DEL-inside-the-mutex stall:

```
a. cold read (wins the mutex): 0.010684 s   key TTL=300  mutex PTTL=979
b. DEL the key at once (= invalidate while the mutex lives): deleted=1  mutex PTTL=966
c. next read: 1.007246 s   key TTL=-2   ← lost the mutex, polled it out, read through, cached nothing
d. read after the mutex is gone: 0.003734 s   key TTL=300  mutex PTTL=985
e. and once more:                0.002159 s   key TTL=299
```

That is TB-019's decision 1 observed in the wild: the refill at (a) took the refresh mutex (`PX 1000`) and never releases it. `DEL` at (b) is what `invalidate` does. The read at (c) finds no key, cannot win the still-live mutex, polls the key for the mutex's lifetime, reads through and caches nothing — **1.007 s** for a request that otherwise takes 4 ms, and the cache stays empty until the mutex dies. In part 2 the whole script ran in under a second, so step 8 landed inside that window. TB-031's compare-and-delete release is the fix; the unit test "a read right after invalidation waits out the refresh mutex" pins it until then.

**Time until stale data cleared on its own (should be ~TTL, i.e. never without invalidation):** 302 s with the 300 s TTL — the key had ~300 s left when the row changed, so the whole TTL. With the TTL dropped by a plain `SET`: never; only `DEL` cleared it.

**`TTL` result after a plain `SET` refresh:** `-1`. After `EXPIRE 300`: `300`. After `SET … KEEPTTL`: still `300`. After a plain `SET` again: `-1`.

**What this changed about how I think about caching:** a TTL is not invalidation, it is a ceiling on how wrong you are allowed to be, and only the writer can lower it — Postgres will never call Redis. So the stale window is a property of the write path, not of the cache; a cache without a writer is simply "stale for one TTL" by definition, and `invalidate` is only as good as the discipline of calling it after every commit. Second: `SET` is not "update the value", it is "replace the key", TTL included; every refresh must say `EX` (or `KEEPTTL`) or it silently promotes a bounded lie into a permanent one — the two bugs look identical for the first 300 s and then diverge forever. Third, the one I did not plan to learn: an expiry-only mutex makes `invalidate` itself expensive for a second, because the invalidation deletes the answer but not the lock that guards refilling it. The lock and the value have to be released together, which is exactly why TB-031 exists.

---

## TB-021 — Proving the race condition

**Task:** naive `RedisHoldStore` (`HGET` → check in TypeScript → `HINCRBY`), 200 concurrent requests against a tier with 10 remaining.

**Date:**

**Requests that received a "success" response:**

**Final `remaining` value in Redis (expected: 0, actual: ?):**

**Was it ever negative?**

**How many "successful" holds were actually oversold?**

**What this changed about how I think about atomicity:**

_(Cross-reference: these numbers belong in `BENCHMARKS.md` §7 too.)_

---

## TB-028 (part 1) — Keyspace notifications and missed expiry events

**Task:** enable `notify-keyspace-events Ex`, subscribe to expiry events, disconnect the subscriber for 20 seconds, reconnect.

**Date:**

**Number of keys that expired while disconnected:**

**Number of expiry events received after reconnecting:**

**Why the sweeper (ZSET + polling) doesn't have this problem:**

---

## TB-028 (part 2) — The FLUSHDB drill

**Task:** create 20 holds, `FLUSHDB`, observe availability, then reconcile.

**Date:**

**Availability shown immediately after `FLUSHDB` (expected: wrong — likely showing full inventory):**

**Availability after calling `POST /_admin/reconcile/:eventId`:**

**Did the 20 in-flight holds survive reconciliation, or were they lost?** _(they should be — Redis was the only place tracking them as "currently held"; think about whether that's the correct trade-off)_

**What this changed about how I think about "Redis restarting in production":**

---

## TB-032 — Rate limiter without atomicity

**Task:** implement rate limiting as separate `INCR` + `EXPIRE` calls, kill the process between them, find the immortal key.

**Date:**

**Command used to find the leaked key:**

**TTL on the leaked key:**

**What this changed about when I reach for a Lua script vs. two plain commands:**

---

## Template for future spikes

```
## <task ID> — <short title>

**Task:**

**Date:**

**What I did:**

**What I expected:**

**What actually happened:**

**What this changed about how I think about the problem:**
```
