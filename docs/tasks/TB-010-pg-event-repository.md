# TB-010 — PgEventRepository

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-010 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-010-pg-event-repository.md`](../implementation-plans/TB-010-pg-event-repository.md)
**Branch / PR:** `feat/TB-010-pg-event-repository` · [#13](https://github.com/Hanna-Hinn/Ticketbox/pull/13) (based on #12)
**ADR:** none — the computation follows the handbook and ADR 0002.

---

## What this task delivered

The first Layer 3 adapter. `PgEventRepository` implements the `EventRepository` port with hand-written SQL against the TB-004 schema and returns `Event` / `TicketTier` entities, never rows. Availability is computed in SQL — `total_qty − SUM(order_items.qty) − SUM(active holds.qty)`, clamped at zero — and is deliberately unindexed so TB-013 has a slow baseline to measure. Twelve integration tests run against a real Postgres 16, each inside a rolled-back transaction.

---

## How it works

```
findById(id)          SELECT … FROM events WHERE id = $1            → null if no row
                      SELECT tiers + availability WHERE event_id = ANY($1)
listUpcoming(now)     SELECT … FROM events WHERE starts_at > $1 ORDER BY starts_at, id
                      SELECT tiers + availability WHERE event_id = ANY($1)   ← one query for all N events
```

```sql
GREATEST(0, t.total_qty
  - COALESCE((SELECT SUM(oi.qty) FROM order_items oi WHERE oi.tier_id = t.id), 0)
  - COALESCE((SELECT SUM(h.qty)  FROM holds h       WHERE h.tier_id = t.id AND h.status = 'active'), 0)
)::int AS remaining
```

Three things in that expression are load-bearing, and each has a test that goes red without it. `COALESCE`: `1000 − NULL` is `NULL` and `GREATEST(0, NULL)` is `0`, so without it a tier with no orders and no holds reports _sold out_. `::int`: `SUM` of an `integer` is `bigint`, which node-postgres returns as a string, and `TicketTier.create` rejects `"997"`. `GREATEST(0, …)`: "reports 0, never negative" enforced where the arithmetic happens.

"Active" means the mirror row's status and nothing about `expires_at`: this adapter has no clock, and a hold the sweeper (TB-026) has not yet marked still counts as held — it under-reports until the sweep and never over-sells (ADR 0002). The two sums are disjoint only if TB-029 flips a hold to `converted` in the same transaction that inserts its `order_items`; if that is ever split, items first (a transient under-report), never status first (an over-report). That invariant now lives in the SQL's header comment.

### Layers touched

| Layer                         | What changed                           |
| ----------------------------- | -------------------------------------- |
| L1, L2                        | None                                   |
| L3 `infrastructure/postgres/` | New: `PgEventRepository.ts`, `pool.ts` |
| L4                            | None — wiring is TB-012                |

### Key files

| File                                                  | What it does                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `infrastructure/postgres/PgEventRepository.ts`        | The two methods, `tiersFor`, `toEvent`, `toTier`; takes `pg.Pool \| pg.ClientBase` |
| `infrastructure/postgres/pool.ts`                     | `createPool(connectionString)` — no caller until TB-012, so untested here          |
| `test/integration/postgres/PgEventRepository.test.ts` | 12 tests; `BEGIN` in `beforeEach`, `ROLLBACK` in `afterEach`                       |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                            | What actually happened                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope: `findById`, `findWithTiers`, `listUpcoming` | Two methods. `findWithTiers` has no port method because `Event` always carries its tiers (TB-007 decision 1); `findById` loads them.                                                                                                                                                                                                   | Inherited deviation, recorded in the plan's decision 1.                                                                                      |
| `ORDER BY t.event_id, t.price_cents`               | `…, t.id` appended. Two tiers at one price had no defined order; the review's probe showed physical order, which changes after an update or a vacuum.                                                                                                                                                                                  | Review, Major. `Event.tiers` is a frozen array the UI renders.                                                                               |
| §6: "Postgres down → `pool.query` rejects → 500"   | **Wrong for an idle client.** When an idle pooled connection drops, the `Pool` emits `'error'`, and an unhandled `'error'` on a Node `EventEmitter` terminates the process. Until TB-012 attaches `pool.on("error", …)` with its logger, "Postgres down" is a crash. Not fixed here — the listener needs the logger TB-012 introduces. | Review, Major. Recorded in the plan's §6 and handed to TB-012.                                                                               |
| "No `pg` type escapes the file"                    | Read as: nothing a caller of the _port_ sees is a `pg` type — no row, no `QueryResult`, no unmapped `Date`. The constructor parameter (`pg.Pool \| pg.ClientBase`) and `createPool`'s return are `pg` types in exported signatures, by design: the adapter's own wiring surface.                                                       | Review, Minor: the literal reading fails on the constructor; the reading that matters holds and is verified by the entity-shaped assertions. |
| "Returns null for an unknown id"                   | Only for a _well-formed_ unknown id. A malformed id (`"not-a-uuid"`) throws the driver's `22P02`; pinned by a test. UUID shape is the boundary's job (TB-011, Zod). TB-018/019's negative cache keys on `null`, so the distinction matters later.                                                                                      | Review, Minor.                                                                                                                               |
| Tie-break test expected the seeded General first   | Ties break on `id`, and `0000…` sorts before `aaaa…`. The test was wrong, the SQL right.                                                                                                                                                                                                                                               | First run of the suite.                                                                                                                      |

---

## 4. Tests shipped

| Level       | Test file                                             | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `test/integration/postgres/PgEventRepository.test.ts` | seeded event as entities (ids, names, `Money`, totals, remaining = total, every `eventId` correct); well-formed unknown id → `null`; malformed id → `22P02`; `1000 − 5 active − 3 converted-via-items`, released and expired not counted → 992; an active hold past `expires_at` still held; oversold VIP → 0; no orders/holds → 1000 (the `COALESCE`); price ties ordered by id; zero-tier event → `tiers: []`; `listUpcoming`: strict `>`, oldest first, tiers loaded, `starts_at` tie by id, far future → `[]` |

26 integration tests total across 4 files, 2.2 s.

**Proven able to fail** — seven SQL sabotages, each reverted, suite green after:

```
SABOTAGE 1: COALESCE removed                      3 failed   (a tier with nothing sold reports sold out)
SABOTAGE 2: ::int cast removed                    7 failed   (TicketTier.create rejects the string "997")
SABOTAGE 3: AND h.expires_at > now() added        2 failed   (decision 2 pinned)
SABOTAGE 4: GREATEST removed                      1 failed   (the oversold tier goes negative)
SABOTAGE 5: ", t.id" tie-break removed            1 failed
SABOTAGE 6: listUpcoming > becomes >=             1 failed
SABOTAGE 7: h.status = 'active' filter removed    1 failed   (converted hold double-counts)
```

One test cannot go red by mutation and says so in its comment: `listUpcoming` on an empty result — removing the `ids.length === 0` guard still returns no rows because `= ANY('{}')` matches nothing. It pins the shape of the empty result (`[]`, not `null`).

**Coverage after this task:** the _unit_ runner reports `infrastructure/**` at 0 % because this adapter is only exercised by the integration suite; the 70 % floor is a unit-coverage gate that TB-042 has to reconcile with adapters that are integration-tested by design.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran `EXPLAIN` and a rolled-back probe against the live Postgres (active/converted/released/expired holds, an oversold tier, a price tie), and read `pg-pool`'s source for the idle-client error path.
**Verdict:** safe to merge after one SQL change and two plan corrections — all applied. Not re-dispatched: no Critical, and the change is one `, t.id`.

| Finding                                                                                           | Severity | Resolution                                                                   |
| ------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| Plan §6 wrong: an idle pooled client's dropped connection emits `'error'` and crashes the process | Major    | Plan corrected; handed to TB-012 (attach `pool.on("error")` with the logger) |
| `ORDER BY` non-deterministic on a price tie                                                       | Major    | `, t.id`                                                                     |
| `sold` and `held` sums are disjoint only under a TB-029 transaction invariant nobody recorded     | Major    | SQL header comment + this doc                                                |
| "No `pg` type escapes the file" not literally true of the constructor                             | Minor    | Reading stated in §3                                                         |
| Malformed id throws rather than returning `null`                                                  | Minor    | By design; pinned by a test                                                  |
| Two statements on a Pool are two snapshots                                                        | Minor    | Harmless (events are never mutated); noted in §6                             |
| `tiersFor`'s `Map` could be a flat list + filter                                                  | Minor    | Kept — conventional and readable                                             |
| `pool.ts` has no caller                                                                           | Minor    | Kept — Scope line and handbook name it; not claimed as tested                |
| Dev database seeded by an older seed (fixed dates)                                                | Noted    | Not this task's; a `pnpm seed` after a reset reconciles it                   |

Findings deliberately **not** fixed: the `Map`, `pool.ts`.

---

## 6. Failure modes, as built

- **Redis down / key evicted:** irrelevant — Postgres only.
- **Postgres down, in-flight query:** `query` rejects → TB-012's handler → 500.
- **Postgres down, idle pooled client:** `Pool` emits `'error'`; **unhandled, the process dies.** TB-012 must attach the listener. Not tested here.
- **Operation runs twice:** read-only.
- **Dies halfway through:** two selects with no write between them. On a `Pool` they can run on two connections and so two snapshots; the availability numbers are each a single-statement snapshot, and events are never mutated, so the halves cannot disagree today.

---

## 7. What I'd do differently

Read the driver's source for the failure path before writing "the error propagates". The plan's "Postgres down → 500" was true for the one path I imagined and false for the one that actually kills processes in production; the reviewer found it in `pg-pool/index.js` in a few minutes.

---

## 8. Follow-ups left behind

- [ ] **TB-012:** `pool.on("error", (err) => log.error(…))` in the composition root, or a dropped idle connection terminates the API.
- [ ] TB-013: `EXPLAIN (ANALYZE, BUFFERS)` on `TIERS_FOR_EVENTS` — the two correlated subqueries are sequential scans of `order_items` and `holds` per tier; that is the baseline. If the `autocannon` target is `GET /events/:id`, `listUpcoming`'s cost is never measured — say so rather than claim it.
- [ ] TB-029: keep the `converted` flip and the `order_items` insert in one transaction (SQL header comment).
- [ ] TB-042: reconcile the 70 % `infrastructure/**` unit-coverage floor with adapters that are integration-tested by design.
