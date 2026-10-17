# Benchmarks

Measured numbers, not estimates. Every row here should be reproducible by running the command listed above it.

Fill this in as you go — each section corresponds to a specific task in `02-product-delivery-plan.md`. The point of this file is to let you say, with a straight face, exactly how much a given optimization bought you and where the win actually came from.

**Machine:** 13th Gen Intel Core i7-13650HX, 32 GB RAM, Windows 11 Pro (10.0.26200), Node v22.20.0. No Docker resource limits set yet — Docker itself arrives in TB-002.
**Date started:** 2026-08-22

---

## 1. Query baseline — unindexed vs. indexed (TB-013)

`GET /events/:id` availability query, before any caching exists.

**Machine for this section (not the laptop above):** the Claude Code cloud container the task was built in — 4 vCPUs, 15 GB RAM, Linux 6.18, Node v22.22, Postgres 16 running locally (not in Docker, `shared_buffers = 128MB`), the API started with `tsx src/main/server.ts`, `LOG_LEVEL=warn`, default `pg.Pool` (10 connections). Measured 2026-10-17. Compare later rows against these only if they were measured the same way on the same machine.

### Fixture

Against the seed alone (9 tiers, 0 holds) both plans are a handful of pages and the numbers mean nothing. The dev database was filled first — 200 000 holds spread round-robin over the nine seeded tiers (30 % `converted`, 30 % `expired`, 20 % `released`, 20 % `active`), one order and one `order_items` row per converted hold. Not idempotent, and it sells the box office out: after the fill every jazz tier reports 0 remaining, so a UI pointed at this database shows nothing for sale. Run it once on a dev database you are willing to drop and `pnpm migrate && pnpm seed` again.

```sql
INSERT INTO holds (token, tier_id, qty, status, expires_at)
SELECT 'bench-' || g,
       (SELECT id FROM ticket_tiers ORDER BY id OFFSET (g % 9) LIMIT 1),
       1 + (g % 4),
       CASE WHEN g % 10 < 3 THEN 'converted'
            WHEN g % 10 < 6 THEN 'expired'
            WHEN g % 10 < 8 THEN 'released'
            ELSE 'active' END,
       now() + interval '120 seconds'
FROM generate_series(1, 200000) AS g;

INSERT INTO orders (id, hold_token, email, total_cents)
SELECT gen_random_uuid(), token, 'bench@example.com', qty * 2000
FROM holds WHERE status = 'converted';

INSERT INTO order_items (id, order_id, tier_id, qty, unit_price_cents)
SELECT gen_random_uuid(), o.id, h.tier_id, h.qty, 2000
FROM orders o JOIN holds h ON h.token = o.hold_token;

ANALYZE holds; ANALYZE order_items;
```

Result: `holds` 200 000 rows / 17 MB (40 000 active), `orders` and `order_items` 60 000 rows / 4.9 MB. Each tier therefore has ~4 445 active holds and ~6 668 order items, scattered across every page of both tables — see the notes for why that matters.

### The query

`TIERS_FOR_EVENTS` from `packages/api/src/infrastructure/postgres/PgEventRepository.ts`, for the seeded jazz event. Each `EXPLAIN` below was run twice and the second run is pasted, so the buffer cache is warm in both rows (`shared hit`, no `read`).

```
EXPLAIN (ANALYZE, BUFFERS)
  SELECT t.id, t.event_id, t.name, t.price_cents, t.total_qty,
         GREATEST(0, t.total_qty
           - COALESCE((SELECT SUM(oi.qty) FROM order_items oi WHERE oi.tier_id = t.id), 0)
           - COALESCE((SELECT SUM(h.qty)  FROM holds h       WHERE h.tier_id = t.id AND h.status = 'active'), 0)
         )::int AS remaining
  FROM ticket_tiers t
  WHERE t.event_id = ANY('{11111111-1111-4111-8111-111111111111}'::uuid[])
  ORDER BY t.event_id, t.price_cents, t.id;
```

### Unindexed

```
 Sort  (cost=26501.80..26501.81 rows=4 width=76) (actual time=51.399..51.404 rows=3 loops=1)
   Sort Key: t.event_id, t.price_cents, t.id
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=8536
   ->  Seq Scan on ticket_tiers t  (cost=0.00..26501.76 rows=4 width=76) (actual time=19.924..51.366 rows=3 loops=1)
         Filter: (event_id = ANY ('{11111111-1111-4111-8111-111111111111}'::uuid[]))
         Rows Removed by Filter: 6
         Buffers: shared hit=8530
         SubPlan 1
           ->  Aggregate  (cost=1385.67..1385.68 rows=1 width=8) (actual time=3.840..3.840 rows=1 loops=3)
                 Buffers: shared hit=1857
                 ->  Seq Scan on order_items oi  (cost=0.00..1369.00 rows=6667 width=4) (actual time=0.007..3.319 rows=6668 loops=3)
                       Filter: (tier_id = t.id)
                       Rows Removed by Filter: 53332
                       Buffers: shared hit=1857
         SubPlan 2
           ->  Aggregate  (cost=5235.13..5235.14 rows=1 width=8) (actual time=13.258..13.258 rows=1 loops=3)
                 Buffers: shared hit=6672
                 ->  Seq Scan on holds h  (cost=0.00..5224.00 rows=4453 width=4) (actual time=0.010..12.933 rows=4445 loops=3)
                       Filter: ((tier_id = t.id) AND (status = 'active'::text))
                       Rows Removed by Filter: 195555
                       Buffers: shared hit=6672
 Planning:
   Buffers: shared hit=145
 Planning Time: 0.756 ms
 Execution Time: 51.526 ms
```

- Planning time: 0.756 ms
- Execution time: **51.5 ms**
- Node type on the expensive step: `Seq Scan on holds` — 200 000 rows read and 195 555 thrown away, **three times** (`loops=3`, once per tier of the event). 8 536 buffers touched in total.

### Indexed

Index added (`migrations/006_availability_indexes.sql`):

```sql
CREATE INDEX holds_tier_id_status_idx ON holds (tier_id, status);
CREATE INDEX order_items_tier_id_idx ON order_items (tier_id);
```

```
 Sort  (cost=12670.42..12670.43 rows=4 width=76) (actual time=22.842..22.851 rows=3 loops=1)
   Sort Key: t.event_id, t.price_cents, t.id
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=8578
   ->  Seq Scan on ticket_tiers t  (cost=0.00..12670.38 rows=4 width=76) (actual time=8.327..22.802 rows=3 loops=1)
         Filter: (event_id = ANY ('{11111111-1111-4111-8111-111111111111}'::uuid[]))
         Rows Removed by Filter: 6
         Buffers: shared hit=8572
         SubPlan 1
           ->  Aggregate  (cost=798.96..798.97 rows=1 width=8) (actual time=2.952..2.953 rows=1 loops=3)
                 Buffers: shared hit=1880
                 ->  Bitmap Heap Scan on order_items oi  (cost=79.96..782.30 rows=6667 width=4) (actual time=0.280..2.078 rows=6668 loops=3)
                       Recheck Cond: (tier_id = t.id)
                       Heap Blocks: exact=1857
                       Buffers: shared hit=1880
                       ->  Bitmap Index Scan on order_items_tier_id_idx  (cost=0.00..78.29 rows=6667 width=0) (actual time=0.204..0.204 rows=6668 loops=3)
                             Index Cond: (tier_id = t.id)
                             Buffers: shared hit=23
         SubPlan 2
           ->  Aggregate  (cost=2363.99..2364.00 rows=1 width=8) (actual time=4.622..4.623 rows=1 loops=3)
                 Buffers: shared hit=6691
                 ->  Bitmap Heap Scan on holds h  (cost=62.06..2352.86 rows=4453 width=4) (actual time=0.768..4.155 rows=4445 loops=3)
                       Recheck Cond: ((tier_id = t.id) AND (status = 'active'::text))
                       Heap Blocks: exact=6671
                       Buffers: shared hit=6691
                       ->  Bitmap Index Scan on holds_tier_id_status_idx  (cost=0.00..60.95 rows=4453 width=0) (actual time=0.442..0.442 rows=4445 loops=3)
                             Index Cond: ((tier_id = t.id) AND (status = 'active'::text))
                             Buffers: shared hit=20
 Planning:
   Buffers: shared hit=172
 Planning Time: 0.711 ms
 Execution Time: 23.091 ms
```

- Planning time: 0.711 ms
- Execution time: **23.1 ms**
- % improvement: **55 %** (2.2× faster). Both sub-plans became `Bitmap Index Scan → Bitmap Heap Scan`; the index scans themselves cost ~7 pages per tier (`Buffers` on a sub-plan node is summed over `loops=3`).

### Load test — `autocannon -c 50 -d 10 http://localhost:3000/events/11111111-1111-4111-8111-111111111111`

A 3-second warm-up run preceded each measured run. Run from `packages/api` with `pnpm exec autocannon …`.

|             | Unindexed | Indexed  |
| ----------- | --------- | -------- |
| req/s (avg) | 76.4      | 310.6    |
| p50 latency | 635 ms    | 159 ms   |
| p99 latency | 802 ms    | 199 ms   |
| mean        | 632.5 ms  | 159.6 ms |

**Notes:**

- **The win is entirely CPU; the index saved no page accesses at all.** Total buffers _rose_ from 8 536 to 8 578 (the index pages are extra). `Heap Blocks: exact=6671` on the indexed `holds` scan against `shared hit=6672` on the unindexed one: the index found the 4 445 matching rows from ~7 index pages per tier, then still fetched **every page of the table** (2 224 pages × 3 tiers), because the fixture scatters each tier's holds round-robin across the whole heap. What disappeared was the filter work — comparing 195 555 non-matching rows per tier, three times. Nothing here was disk I/O either way: both runs were warm (`shared hit`, no `read`).
- **The index that would remove the heap visits is a different one**, and it was deliberately not taken here. `CREATE INDEX … ON holds (tier_id) INCLUDE (qty) WHERE status = 'active'` indexes only the live set (tiny, churning every 120 s, while `holds` is an audit trail that grows for life — 80 % of this fixture is dead weight to the composite) and lets the sub-plan become an Index Only Scan. Against it: a partial index is used only when the planner can prove the query implies `status = 'active'` — a literal does, a parameter would not, and the fallback is a silent seq scan; and index-only scans depend on the visibility map, which on a table whose rows flip status every two minutes leaves the recently-touched pages visited anyway. The plain composite is the textbook control the Scope line names and answers any `(tier_id, status)` question. The partial index is the thing to measure when TB-022 writes the counter-rebuild query, not before. Neither helps the sweeper's `status = 'active' AND expires_at < now()`; that is TB-026/027's decision.
- **The HTTP-level win (4.1×) is bigger than the query-level win (2.2×) because of queueing.** 50 connections share a 10-connection pool; every query is CPU-bound inside Postgres on 4 vCPUs, so requests wait in line and the wait compounds. Little's law checks out both times: 50 in flight ÷ 76.4 req/s ≈ 654 ms against the observed mean latency of 632.5 ms; 50 ÷ 310.6 ≈ 161 ms against the indexed mean of 159.6 ms. Halve the service time and the queue drains more than twice as fast.
- **`GET /events/:id` is two round-trips**, not one: `findById` fetches the event row, then `tiersFor` runs the query above. The HTTP numbers include both and the JSON serialisation; the `EXPLAIN` numbers are only the second query.
- **`GET /events` is not measured here.** Its availability query is the same shape over all upcoming events (TB-010 flagged its cost); the indexes help it the same way, but no number was taken.
- **What this means for Redis.** Every later row in §2 (cache-aside) and §7 (live counter) compares against **the indexed row — 23 ms / 311 req/s / p50 159 ms** — never the unindexed one. Any "Redis made it faster" claim that beats 76 req/s but not 311 req/s was a win that belonged to this index.

---

## 2. Cache-aside (TB-019)

Same load test, same endpoint, `CachedEventRepository` in front of the **indexed** repository — compare against the indexed row above, not the unindexed one.

|                         | Indexed (no cache) | Cached, cold | Cached, warm |
| ----------------------- | ------------------ | ------------ | ------------ |
| req/s (avg)             |                    |              |              |
| p50 latency             |                    |              |              |
| p99 latency             |                    |              |              |
| Postgres queries issued |                    |              |              |

**Hit ratio at steady state** (`GET /_stats`): _fill in_

**Notes:** _how much of the win is the cache vs. how much was already spent by the index?_

---

## 3. Pipelining vs. MULTI vs. Lua (TB-040)

1000 sequential `GET`s issued three ways.

```
<paste the benchmark script or command>
```

| Method                   | Total time | Round trips | Atomic? |
| ------------------------ | ---------- | ----------- | ------- |
| Sequential (no pipeline) |            | 1000        | No      |
| Pipelined                |            | 1           | No      |
| Lua script               |            | 1           | Yes     |

**Notes:** _pipelining and Lua both cut round-trips — write down, in your own words, what Lua buys you that pipelining doesn't, and why that distinction mattered in Stage 5._

---

## 4. KEYS vs. SCAN under load (TB-040)

Keyspace size when measured: `<N>` keys.

|                                                   | `KEYS ticketbox:v1:hold:*` | `SCAN` (COUNT 100) |
| ------------------------------------------------- | -------------------------- | ------------------ |
| Time to complete                                  |                            |                    |
| p99 latency of a concurrent `GET` during the scan |                            |                    |

**Notes:**

---

## 5. Eviction policy behaviour (TB-040)

`maxmemory 20mb`

| Policy         | `evicted_keys` after fill | Writes fail? | Did a hold/lock key get evicted? |
| -------------- | ------------------------- | ------------ | -------------------------------- |
| `noeviction`   |                           |              |                                  |
| `allkeys-lru`  |                           |              |                                  |
| `volatile-lru` |                           |              |                                  |

**Notes:** _did volatile-lru actually fix the correctness problem, or just make it less likely?_

---

## 6. Persistence — RDB vs. AOF (TB-040)

`docker kill` (not `stop`) mid-write, then restart.

| Config   | Data written before kill | Data present after restart |
| -------- | ------------------------ | -------------------------- |
| RDB only |                          |                            |
| AOF      |                          |                            |

**Chosen config for this project:** _fill in, with a one-line reason_

---

## 7. Concurrency correctness (TB-021 vs. TB-022)

The naive `HGET`-then-`HINCRBY` implementation vs. the Lua-scripted one. 200 concurrent requests against a tier with 10 remaining.

| Implementation       | Requests that "succeeded" | Final availability | Oversold by  |
| -------------------- | ------------------------- | ------------------ | ------------ |
| Naive (TB-021 spike) |                           |                    |              |
| Lua (TB-022)         |                           | 0 (expected)       | 0 (expected) |

**Notes:** _paste the actual numbers you saw in the spike — this is the row that justifies the whole project._

---

## Summary

_Once all sections above are filled in, write 3–5 sentences here: which optimization mattered most, which mattered least, and what you'd tell a colleague who asked "do we actually need Redis for this"._
