# Benchmarks

Measured numbers, not estimates. Every row here should be reproducible by running the command listed above it.

Fill this in as you go — each section corresponds to a specific task in `02-product-delivery-plan.md`. The point of this file is to let you say, with a straight face, exactly how much a given optimization bought you and where the win actually came from.

**Machine:** _fill in — CPU, RAM, OS, Docker resource limits if constrained_
**Date started:** _fill in_

---

## 1. Query baseline — unindexed vs. indexed (TB-013)

`GET /events/:id` availability query, before any caching exists.

```
EXPLAIN (ANALYZE, BUFFERS) <paste the query>
```

### Unindexed

```
<paste EXPLAIN output>
```

- Planning time:
- Execution time:
- Node type on the expensive step (`Seq Scan` / `Nested Loop` / ...):

### Indexed

Index added: `<paste the CREATE INDEX statement>`

```
<paste EXPLAIN output>
```

- Planning time:
- Execution time:
- % improvement:

### Load test — `autocannon -c 50 -d 10 http://localhost:3000/events/<id>`

| | Unindexed | Indexed |
|---|---|---|
| req/s (avg) | | |
| p50 latency | | |
| p99 latency | | |

**Notes:** _what actually changed, in your own words — was it the index, or something else?_

---

## 2. Cache-aside (TB-019)

Same load test, same endpoint, `CachedEventRepository` in front of the **indexed** repository — compare against the indexed row above, not the unindexed one.

| | Indexed (no cache) | Cached, cold | Cached, warm |
|---|---|---|---|
| req/s (avg) | | | |
| p50 latency | | | |
| p99 latency | | | |
| Postgres queries issued | | | |

**Hit ratio at steady state** (`GET /_stats`): _fill in_

**Notes:** _how much of the win is the cache vs. how much was already spent by the index?_

---

## 3. Pipelining vs. MULTI vs. Lua (TB-040)

1000 sequential `GET`s issued three ways.

```
<paste the benchmark script or command>
```

| Method | Total time | Round trips | Atomic? |
|---|---|---|---|
| Sequential (no pipeline) | | 1000 | No |
| Pipelined | | 1 | No |
| Lua script | | 1 | Yes |

**Notes:** _pipelining and Lua both cut round-trips — write down, in your own words, what Lua buys you that pipelining doesn't, and why that distinction mattered in Stage 5._

---

## 4. KEYS vs. SCAN under load (TB-040)

Keyspace size when measured: `<N>` keys.

| | `KEYS ticketbox:v1:hold:*` | `SCAN` (COUNT 100) |
|---|---|---|
| Time to complete | | |
| p99 latency of a concurrent `GET` during the scan | | |

**Notes:**

---

## 5. Eviction policy behaviour (TB-040)

`maxmemory 20mb`

| Policy | `evicted_keys` after fill | Writes fail? | Did a hold/lock key get evicted? |
|---|---|---|---|
| `noeviction` | | | |
| `allkeys-lru` | | | |
| `volatile-lru` | | | |

**Notes:** _did volatile-lru actually fix the correctness problem, or just make it less likely?_

---

## 6. Persistence — RDB vs. AOF (TB-040)

`docker kill` (not `stop`) mid-write, then restart.

| Config | Data written before kill | Data present after restart |
|---|---|---|
| RDB only | | |
| AOF | | |

**Chosen config for this project:** _fill in, with a one-line reason_

---

## 7. Concurrency correctness (TB-021 vs. TB-022)

The naive `HGET`-then-`HINCRBY` implementation vs. the Lua-scripted one. 200 concurrent requests against a tier with 10 remaining.

| Implementation | Requests that "succeeded" | Final availability | Oversold by |
|---|---|---|---|
| Naive (TB-021 spike) | | | |
| Lua (TB-022) | | 0 (expected) | 0 (expected) |

**Notes:** _paste the actual numbers you saw in the spike — this is the row that justifies the whole project._

---

## Summary

_Once all sections above are filled in, write 3–5 sentences here: which optimization mattered most, which mattered least, and what you'd tell a colleague who asked "do we actually need Redis for this"._