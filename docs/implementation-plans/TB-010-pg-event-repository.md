# TB-010 — PgEventRepository

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-010 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-010-pg-event-repository` (stacked on `feat/TB-009-boundary-enforcement`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `pg` Pool, hand-written SQL, row → entity mappers. `findById`, `findWithTiers`, `listUpcoming`. Availability computed in SQL as `total_qty − sold − active holds`. **Leave it unindexed for now** — TB-013 needs a slow baseline.

**Acceptance:** returns domain entities, never raw rows. No `pg` type escapes the file.

**Tests:** **integration** against real Postgres — finds a seeded event with tiers; returns null for an unknown ID; availability maths is correct with holds and orders present; a tier with 0 remaining reports 0, never negative.

**Depends on:** TB-007 (open, PR #10), TB-004 (open, PR #7) — both below this branch in the stack: ☑

---

## 2. What I understand this to mean

The first Layer 3 adapter: a class implementing the `EventRepository` port (TB-007) with hand-written SQL against the TB-004 schema, turning rows into `Event` and `TicketTier` entities (TB-006). The interesting line is the availability computation — it is the Postgres half of ADR 0002 ("the computed count"), and the query that TB-013 benchmarks unindexed and then indexes.

`findWithTiers` from the Scope wording does not exist as a port method: TB-007 decision 1 dropped it because `Event` always carries its tiers. This task implements the port as it is and records the divergence (§3 decision 1).

---

## 3. Approach

### Layers touched

| Layer                         | What changes                                          |
| ----------------------------- | ----------------------------------------------------- |
| L1, L2                        | None                                                  |
| L3 `infrastructure/postgres/` | New: `pool.ts` (`createPool`), `PgEventRepository.ts` |
| L4                            | None — the composition root is TB-012                 |

### The SQL

Two statements per call (an events query, then one tiers query for all the events found), grouped in TypeScript. No JSON aggregation: two plain selects are easier to read, easier to `EXPLAIN` in TB-013, and the join is at most three events wide.

```sql
-- tiers for a set of events, with availability
SELECT t.id, t.event_id, t.name, t.price_cents, t.total_qty,
       GREATEST(0, t.total_qty
         - COALESCE((SELECT SUM(oi.qty) FROM order_items oi WHERE oi.tier_id = t.id), 0)
         - COALESCE((SELECT SUM(h.qty)  FROM holds h       WHERE h.tier_id = t.id AND h.status = 'active'), 0)
       )::int AS remaining
FROM ticket_tiers t
WHERE t.event_id = ANY($1)
ORDER BY t.event_id, t.price_cents
```

No index beyond the primary keys — the two correlated subqueries are sequential scans of `order_items` and `holds` per tier, which is precisely the baseline TB-013 measures before adding the composite index.

### Decisions this plan is making

1. **`findById` and `listUpcoming(now)` only — no `findWithTiers`.** The port (TB-007) has no such method because `Event` requires `tiers`; both methods load tiers. This is a deliberate deviation from the Scope line's wording, inherited from TB-007 decision 1 and recorded here so the delivery plan's three names are not silently reduced to two.
2. **"Active holds" means `status = 'active'`, nothing about `expires_at`.** The repository has no clock (`findById(id)` takes none, and a repository must not read the system clock any more than a use case may), and ADR 0002 already describes this exact behaviour: a hold that expired in Redis but whose mirror row the sweeper (TB-026) has not yet marked still counts as held here, so the computed number under-reports until the sweeper runs and never over-sells. Using the database's `now()` would introduce a third clock that no test can control.
3. **`sold` is `SUM(order_items.qty)`, not a count of converted holds.** The order is the permanent record; a `converted` hold row is excluded from "held" by its status and its tickets appear once, via its order items. A `released` or `expired` row counts nowhere.
4. **`GREATEST(0, …)` in SQL, and `::int`.** "Reports 0, never negative" is enforced where the arithmetic happens; `TicketTier.create` would throw on a negative, which is the right second line of defence but the wrong first one. `SUM` of an `integer` column is `bigint`, which node-postgres returns as a _string_; the cast keeps the mapper free of `Number()` conversions that would hide a wrong type.
5. **The constructor takes `pg.Pool | pg.ClientBase`.** Both have `query`. A pool is what the composition root passes; a `ClientBase` (a `Client` or a `PoolClient`) is what lets an integration test wrap each case in `BEGIN … ROLLBACK` on one connection — the handbook's isolation rule — and what TB-029 will need to run the repository inside a transaction. The port's public surface (return types) carries no `pg` type; the constructor parameter is the adapter's own business, which is what "no `pg` type escapes the file" is about.
6. **`listUpcoming` computes availability for every tier of every upcoming event.** TB-007 decision 9 asked this task to confront the cost. Confronted: three seeded events, nine tiers, two subqueries each. It is the query TB-013 benchmarks, so a lighter list shape would remove the thing being measured. Revisit only if TB-013's numbers say so.
7. **`pool.ts` is three lines**: `createPool(connectionString)`. It exists because the Scope line says "`pg` Pool" and the handbook's folder listing names it; TB-012 calls it. No pool-size tuning, no lifecycle hooks — nothing asked for them.
8. **Test isolation is `BEGIN` in `beforeEach`, `ROLLBACK` in `afterEach`, on one `Client`, after one migrate + seed in `beforeAll`.** Exactly the handbook §4.1 rule, made possible by decision 5. Tests that need holds and orders insert them inside the transaction with plain SQL; no `HoldRepository` exists yet (TB-024) and reaching for one here would be the wrong dependency.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File                                                               | New / Changed |
| ------------------------------------------------------------------ | ------------- |
| `packages/api/src/infrastructure/postgres/pool.ts`                 | New           |
| `packages/api/src/infrastructure/postgres/PgEventRepository.ts`    | New           |
| `packages/api/test/integration/postgres/PgEventRepository.test.ts` | New           |

---

## 5. Test plan

All **integration**, real Postgres 16, `ticketbox_test`, one transaction per test.

| Test                                                                                                       | What it would catch                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| finds a seeded event with its three tiers as entities (ids, names, prices as `Money`, `remaining = total`) | a mapper wrong on any column; a `pg` row leaking                                    |
| returns `null` for an unknown id                                                                           | a throw or an empty `Event`                                                         |
| availability = total − order items − active holds, with converted/released/expired holds not counted       | the subqueries, the status filter, the double-count of a converted hold             |
| a tier whose order items exceed its total reports 0, never negative                                        | the `GREATEST`                                                                      |
| `listUpcoming(now)` returns only events starting after `now`, with tiers, oldest first                     | the `WHERE`, the boundary (`>` not `>=`, matching the in-memory fake), the ordering |
| the tier of a sold-out seed (`total 0`) reports 0                                                          | the Scope's own "sold out" case through the real query                              |

**Concurrency:** N/A — read-only adapter. The inventory write path is TB-022.

**How each test will be proven able to fail:** drop `GREATEST` (negative test goes red); change `h.status = 'active'` to no filter (converted hold double-counts); change `>` to `>=` in `listUpcoming` (boundary test goes red); return `total_qty` as `remaining` (availability test goes red).

---

## 6. Risks and failure modes

- **What if Redis is down?** Irrelevant — Postgres only.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Read-only; idempotent by nature.
- **What if it dies halfway through?** Two selects with no write between them; a failure between them surfaces as a thrown `pg` error (a bug, not a value) and nothing is half-done.
- **What if Postgres is down?** `pool.query` rejects; the error propagates to TB-012's error handler as a 500. Correct: a dead database is not an expected outcome of "find an event".

---

## 7. Could Postgres already do this?

This _is_ the Postgres side. The honest note is the inverse: this query is what Redis will replace on the hot read path (TB-018 caches it, TB-022 keeps the live count). TB-013 measures how slow it is first, so the replacement can be credited honestly.

---

## 8. Open questions

None blocking. Decision 2 (no `expires_at` in the active-holds filter) is the one to push on; the counter-argument is that a stale `active` row under-reports availability until the sweeper runs, and ADR 0002 accepts that.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed; the computation follows the handbook and ADR 0002
- ☑ Task doc — `docs/tasks/TB-010-pg-event-repository.md`
- ☐ Benchmark entry — TB-013's, not this task's
- ☐ NOTES entry — not a SPIKE task
