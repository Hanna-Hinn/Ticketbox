# Notes

Write-ups from the spike tasks — the ones in `02-product-delivery-plan.md` marked **not merged**. These produce no code, only understanding, so this file is where that understanding gets kept.

Each entry: what you did, what you expected, what actually happened, and what it changed about how you think about the problem. A few honest sentences beat a polished paragraph — this file is for you, six months from now, more than for anyone else.

---

## TB-019a — Cache invalidation failures

**Task:** comment out cache invalidation, update an event's name directly in `psql`, watch the API serve stale data. Then refresh a cached key with plain `SET` (no `EX`) and check `TTL`.

**Date:**

**What I did:**

**What I expected:**

**What actually happened:**

**Time until stale data cleared on its own (should be ~TTL, i.e. never without invalidation):**

**`TTL` result after a plain `SET` refresh:**

**What this changed about how I think about caching:**

---

## TB-021 — Proving the race condition

**Task:** naive `RedisHoldStore` (`HGET` → check in TypeScript → `HINCRBY`), 200 concurrent requests against a tier with 10 remaining.

**Date:**

**Requests that received a "success" response:**

**Final `remaining` value in Redis (expected: 0, actual: ?):**

**Was it ever negative?**

**How many "successful" holds were actually oversold?**

**What this changed about how I think about atomicity:**

*(Cross-reference: these numbers belong in `BENCHMARKS.md` §7 too.)*

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

**Did the 20 in-flight holds survive reconciliation, or were they lost?** *(they should be — Redis was the only place tracking them as "currently held"; think about whether that's the correct trade-off)*

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