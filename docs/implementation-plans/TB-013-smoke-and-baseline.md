# TB-013 — Smoke suite and the performance baseline

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-013 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-013-smoke-and-baseline` (stacked on `feat/TB-012-composition-root`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** the 6-assertion smoke suite from handbook §4.1. Then: `EXPLAIN (ANALYZE, BUFFERS)` on the availability query, recorded in `docs/BENCHMARKS.md`; add the composite index; re-run and record again; `autocannon -c 50 -d 10` before and after the index.

**Acceptance:** `BENCHMARKS.md` has an "unindexed" and an "indexed" row with real numbers and your own commentary.

**Tests:** **smoke** — all 6.

**Note:** this is the control experiment. I think it's the most quietly important task in the plan — it's what stops you from crediting Redis with a win that belonged to an index.

**Depends on:** TB-012 (open, PR #15 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

Two deliverables with one purpose: know what the system does _before_ Redis touches it. The smoke suite is a running-system check over real HTTP; the benchmark is the number every later "Redis made it faster" claim is compared against. Handbook §4.1's six smoke assertions are the spec, and three of them (`POST /holds`, `DELETE /holds/:token`, the web root) name things that do not exist until TB-014, TB-022 and TB-023. §3 decision 1 says what to do about that.

The benchmark needs data: against nine tiers and zero holds, Postgres will sequential-scan whether an index exists or not, and the numbers would say nothing. §3 decision 4 fills the tables first and records exactly how.

---

## 3. Approach

### Layers touched

| Layer         | What changes                                                         |
| ------------- | -------------------------------------------------------------------- |
| L1–L4         | None — no application code                                           |
| `migrations/` | New: `006_availability_indexes.sql`                                  |
| `test/smoke/` | New: `smoke.test.ts`; `vitest.smoke.config.ts`; `test:smoke` scripts |
| CI            | `integration` job starts the API after seeding and runs `test:smoke` |
| `docs/`       | `BENCHMARKS.md` §1 filled with measured numbers                      |

### The smoke suite

`test/smoke/smoke.test.ts` — plain Vitest hitting `SMOKE_BASE_URL` (default `http://localhost:3000`) with `fetch`. No fakes, no inject: the point is the running system.

| #   | Handbook assertion                    | This task                                                             |
| --- | ------------------------------------- | --------------------------------------------------------------------- |
| 1   | `/health` 200 with both engines green | 200 with `postgres: "ok"`; the `redis` key is asserted from TB-017 on |
| 2   | `/events` non-empty                   | ✓                                                                     |
| 3   | `/events/:id` 200 for a seeded id     | ✓ (the fixed seed id)                                                 |
| 4   | `POST /holds` 201                     | `it.todo("… TB-022/TB-025")`                                          |
| 5   | `DELETE /holds/:token` 200            | `it.todo("… TB-023")`                                                 |
| 6   | the web root HTML                     | `it.todo("… TB-014")`                                                 |

### The benchmark

```
1. fill the dev database with volume (decision 4): 200 000 holds across the seeded tiers (status mix),
   60 000 orders on converted holds, 60 000 order_items — all via generate_series in psql
2. EXPLAIN (ANALYZE, BUFFERS) the tiers-with-availability query for the jazz event   ← unindexed
3. autocannon -c 50 -d 10 http://localhost:3000/events/<jazz>                          ← unindexed
4. pnpm migrate  (006_availability_indexes.sql)
5. EXPLAIN again, autocannon again                                                     ← indexed
6. record everything in BENCHMARKS.md §1: the fill commands, both plans, both load runs, commentary
```

### Decisions this plan is making

1. **Three of the six smoke assertions are `it.todo`, named after the task that makes them real.** The delivery plan sequences TB-013 before the hold routes (TB-022/023) and the web app (TB-014) exist; a test against a route that is not there cannot be anything but a placeholder. `it.todo` is not `it.skip`: it does not pretend to pass, Vitest reports it as todo, and the name carries the task id. Each of those tasks turns its todo into a real assertion — that is written into their follow-ups here. The Tests line says "all 6"; this is the honest shape of "all 6" at this point in the sequence.
2. **The index is two indexes, in one migration.** The availability query's two correlated subqueries scan `holds` by `(tier_id, status)` and `order_items` by `(tier_id)`. "The composite index" in the Scope line is `holds (tier_id, status)` — the one with a real second column, on the table that grows with every hold. `order_items (tier_id)` goes in the same migration because the other subquery is the same shape and leaving it out would make the "indexed" row half-indexed. Both are plain B-trees; no partial index, no covering `INCLUDE`, until a plan says they are needed.
3. **Migration `006`, and the migration test's filename list grows to six.** The handbook's folder sketch shows `006_outbox.sql`; numbers are allocated by arrival, and the outbox (TB-033) becomes `007`.
4. **Volume is generated with `generate_series` in `psql`, recorded verbatim in `BENCHMARKS.md`, against the dev database — not the test database and not a seed change.** The benchmark must be reproducible by command ("a BENCHMARKS row without a command that reproduces it is worthless"); a SQL snippet in the doc is the command. The seed stays small (the UI needs readable numbers), and `ticketbox_test` is reset by the integration suite. 200 000 holds / 60 000 order items is enough that a sequential scan per tier costs milliseconds and the planner has a reason to prefer an index.
5. **`autocannon` targets `GET /events/:id`, not `GET /events`.** `/events/:id` is the page TB-018 caches and TB-022 moves to Redis, so it is the number to compare later. `listUpcoming`'s cost is therefore _not_ measured here (TB-010's task doc flagged this), and the doc says so.
6. **CI runs smoke in the existing `integration` job**, after seed: start `tsx src/main/server.ts` in the background, wait for `/health`, run `test:smoke`. One job, because smoke needs the same compose stack and seed; the handbook's order (`… → test:integration → test:smoke`) is preserved as step order.
7. **Numbers are measured in this session's container, and `BENCHMARKS.md` says so.** The file's header names a Windows laptop; TB-013's rows get their own machine line (vCPUs, RAM, Postgres 16 running locally rather than in Docker). A number without its machine is a number without meaning.

### New or changed ports / Redis keys / Lua scripts

None.

---

## 4. Files

| File                                                        | New / Changed                  |
| ----------------------------------------------------------- | ------------------------------ |
| `migrations/006_availability_indexes.sql`                   | New                            |
| `packages/api/test/smoke/smoke.test.ts`                     | New                            |
| `packages/api/vitest.smoke.config.ts`                       | New                            |
| `packages/api/package.json`, root `package.json`            | Changed (`test:smoke`)         |
| `.github/workflows/ci.yml`                                  | Changed (start API, run smoke) |
| `packages/api/test/integration/postgres/migrations.test.ts` | Changed (six files)            |
| `docs/BENCHMARKS.md`                                        | Changed (§1 filled)            |

---

## 5. Test plan

| Level       | Test                                                 | What it would catch                     |
| ----------- | ---------------------------------------------------- | --------------------------------------- |
| Smoke       | 1–3 above over real HTTP against the running API     | a system that boots but is not usable   |
| Smoke       | 4–6 as `it.todo`                                     | —                                       |
| Integration | `migrations.test.ts` sees six files applied in order | the index migration not being picked up |

**Concurrency:** N/A.

**How the smoke tests will be proven able to fail:** run them with the API stopped (connection refused → all three red), and with `SMOKE_BASE_URL` pointing at a wrong port.

---

## 6. Risks and failure modes

- **What if Redis is down?** Smoke #1 cannot tell yet (no Redis check until TB-017). Said in the test name.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Smoke is read-only. `pnpm migrate` twice applies `006` once. The volume fill is _not_ idempotent and says so in the doc — it is a benchmark fixture, run once on a dev database you are willing to reset.
- **What if it dies halfway through?** Smoke: a failed assertion. Migration: one transaction. Fill: partial rows in the dev database; re-run after `pnpm migrate && pnpm seed` on a fresh database.
- **The benchmark lies if** the index is never used (tables too small), the API process is not warm, or the numbers come from different machines. Decisions 4 and 7 address each; a warm-up run precedes each measured run.

---

## 7. Could Postgres already do this?

This task _is_ the Postgres answer, measured, so that TB-018/TB-019 ("cached") and TB-022 ("live counter") can be compared against it honestly. The Note on the task says why: it stops a win that belonged to an index from being credited to Redis.

---

## 8. Open questions

None blocking. Decision 1 (`it.todo` for the three routes that do not exist yet) is the one a reviewer may want done differently; the alternative — not shipping those three lines at all — would leave the suite silently incomplete rather than visibly so.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed; an index is not an architecture decision
- ☑ Task doc — `docs/tasks/TB-013-smoke-and-baseline.md`
- ☑ Benchmark entry — `docs/BENCHMARKS.md` §1
- ☐ NOTES entry — not a SPIKE task
