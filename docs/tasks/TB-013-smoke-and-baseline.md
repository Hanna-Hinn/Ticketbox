# TB-013 — Smoke suite and the performance baseline

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-013 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-013-smoke-and-baseline.md`](../implementation-plans/TB-013-smoke-and-baseline.md)
**Branch / PR:** `feat/TB-013-smoke-and-baseline` · [#16](https://github.com/Hanna-Hinn/Ticketbox/pull/16) (based on #15)
**ADR:** none — an index is not an architecture decision. The index _alternative_ is argued in `BENCHMARKS.md` §1 for TB-022 to pick up.

---

## What this task delivered

The control experiment. `pnpm test:smoke` asks the running system six questions over real HTTP (three answered, three `todo` until their routes exist), CI asks them after seed on every PR, and [`docs/BENCHMARKS.md` §1](../BENCHMARKS.md) now holds the number every later "Redis made it faster" claim is compared against: the availability query at 51.5 ms unindexed and 23.1 ms with migration `006`, 76 → 311 req/s under `autocannon -c 50 -d 10`. Stage 2 is complete.

---

## How it works

```
test:smoke     vitest.smoke.config.ts → test/smoke/smoke.test.ts → fetch(SMOKE_BASE_URL ?? localhost:3000)
                 /health 200 {postgres: ok} · /events non-empty · /events/<seed id> 200 · 3 × it.todo

CI integration job
  compose up → migrate → seed → test:integration → tsx server.ts & → wait /health (≤30 s, else exit 1) → test:smoke

migrations/006_availability_indexes.sql
  holds (tier_id, status)   ← the composite the Scope line names
  order_items (tier_id)     ← the other sub-query, same shape

BENCHMARKS.md §1
  fixture SQL (200 000 holds, 60 000 orders/items, verbatim) → EXPLAIN (ANALYZE, BUFFERS) ×2 → autocannon ×2 → commentary
```

The smoke suite is the only test level with nothing faked, so its one knob is the base URL. It imports `SEED_EVENTS` for the fixed jazz id rather than repeating the UUID; an empty seed list is a thrown error, not an assertion.

The benchmark's lesson, in one line: **the index saved no page accesses at all** (total buffers went _up_, 8 536 → 8 578). The fixture scatters each tier's holds round-robin across the heap, so the bitmap heap scan still visits every page; what the index removed was CPU — evaluating the filter on ~195 000 non-matching rows per tier, three times. The 4.1× HTTP-level win over a 2.2× query-level win is queueing (Little's law: 50 in flight ÷ throughput matches the observed mean latency both times).

### Layers touched

| Layer | What changed                                                                                 |
| ----- | -------------------------------------------------------------------------------------------- |
| L1–L4 | None — no application code                                                                   |
| —     | `migrations/006_availability_indexes.sql`; `test/smoke/`; `vitest.smoke.config.ts`; CI; docs |

### Key files

| File                                      | What it does                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `packages/api/test/smoke/smoke.test.ts`   | The six assertions; three real, three `it.todo` naming their task |
| `packages/api/vitest.smoke.config.ts`     | `test/smoke/**`, 5 s timeout, nothing started                     |
| `migrations/006_availability_indexes.sql` | The two B-tree indexes with the why-comment                       |
| `.github/workflows/ci.yml`                | Background API + health gate + `test:smoke` after integration     |
| `docs/BENCHMARKS.md` §1                   | Fixture, both plans, both load runs, commentary                   |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                             | What actually happened                                                                                                                                                                                                                                                                                                          | Why                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "Record both plans and commentary"                                  | The first commentary said the win was "half CPU, not I/O". The two plans it sat under disproved it: buffers rose, every access was a `shared hit`, and `Heap Blocks: exact=6671` ≈ the unindexed 6 672. Rewritten to "entirely CPU", with the arithmetic.                                                                       | Review, Critical. Writing the sentence before re-reading the numbers under it.            |
| A "requests" row in the load-test table                             | Deleted. autocannon's summary line prints requests _sent_ (in-flight included) through an abbreviating formatter — "814" and "3k" are neither the completed count nor exact. A "mean" row from the Avg column replaced it, and the Little's-law check now compares against the mean, which is what the law gives.               | Review, Critical: a number not observed.                                                  |
| CI health wait loops up to 30 s then runs smoke                     | If the API never boots the loop exits 0 and the failure lands in the smoke step with ECONNREFUSED — misattributed, not silent. An explicit final `curl … \|\| { echo; cat api.log; exit 1; }` added. Verified locally: exit 1 with the message.                                                                                 | Review, Major.                                                                            |
| Commentary names `CLUSTER` as what would show the heap cost         | Wrong tool. The thing that would actually remove the 6 671 heap visits in a shippable way is a partial covering index `holds (tier_id) INCLUDE (qty) WHERE status = 'active'`. Both sides are now in §1 — including why it was deliberately not taken here (control experiment; a parameterised status would silently skip it). | Review, Major — recorded, not built. TB-022 measures it when it writes the rebuild query. |
| "The index scans cost 20–23 buffers each"                           | Sub-plan `Buffers` are summed over `loops=3`: ~7 pages per tier.                                                                                                                                                                                                                                                                | Review, Minor.                                                                            |
| Smoke guards its fixture with `expect(seededEventId).toBeDefined()` | `expect` does not narrow; the id stayed `string \| undefined` into the URL. An empty seed is a bug → explicit `throw`.                                                                                                                                                                                                          | Review, Minor; CLAUDE.md rule 6.                                                          |
| No test for the index itself                                        | `migrations.test.ts` now asserts both index names after `runMigrations`. Before it, a recorded migration creating the wrong index passed every test in the repo.                                                                                                                                                                | Review, "For the Test Phase".                                                             |
| Scope: "add the composite index" (singular)                         | Migration `006` adds two: `holds (tier_id, status)` and `order_items (tier_id)`. Plan decision 2 widened it so the "indexed" row is not half-indexed; the reviewer agreed.                                                                                                                                                      | Plan-level widening, recorded.                                                            |
| —                                                                   | Plan decisions 1, 2 and 6 (`it.todo` ×3, two indexes, smoke inside the integration job) were approved by blanket go-ahead and first challenged by the reviewer; all three held.                                                                                                                                                 | Recorded, not smoothed over.                                                              |
| —                                                                   | Sabotage 1 used `git checkout` to restore the test file and silently discarded the uncommitted index-name test; sabotage 2 then "passed" with 5 tests. Caught by the count, re-added, re-run.                                                                                                                                   | Process bug. Restore from a copy, not from the index, when the file has uncommitted work. |

---

## 4. Tests shipped

| Level       | Test file                                      | Behaviour asserted                                                                                                                                          |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke       | `test/smoke/smoke.test.ts`                     | `/health` 200 with `postgres: ok`; `/events` non-empty; `/events/<seed id>` 200 with that id; `todo` ×3 for `POST /holds`, `DELETE /holds/:token`, web root |
| Integration | `test/integration/postgres/migrations.test.ts` | Six files applied in order; `holds_tier_id_status_idx` and `order_items_tier_id_idx` exist by name                                                          |

99 unit (1.3 s) · 56 integration (4.7 s) · smoke `3 passed | 3 todo` (0.4 s locally; 0.3 s in CI, [run 39044271746](https://github.com/Hanna-Hinn/Ticketbox/actions/runs/39044271746), the background server observed surviving between steps).

**Proven able to fail** — four sabotages, each reverted, suites green after:

```
SABOTAGE 1: SMOKE_BASE_URL=http://localhost:3999 (nothing listening)     3 failed  — connect ECONNREFUSED 127.0.0.1:3999
SABOTAGE 2: API on :3001 against a migrated, UNSEEDED database            2 failed  — expected [] to not have a length of +0; expected 404 to be 200
SABOTAGE 3: "006_availability_indexes.sql" removed from MIGRATION_FILES   2 failed  — records every applied file…; applies nothing… on a second run
SABOTAGE 4: index renamed holds_tier_idx inside migration 006             1 failed  — creates the availability indexes by name
HEALTH WAIT: the CI step's loop pointed at a dead port                    "API did not become healthy within 30s", exit=1
```

**Coverage after this task:** unchanged — no `src/**` line was added or removed.

**The two autocannon summaries behind BENCHMARKS.md §1's load-test table**, verbatim (the reviewer asked for them next to the numbers; the `EXPLAIN` rows already sit beside their plans). The trailing "requests in" line is autocannon's _sent_ count, abbreviated — see §3 for why it is not in the table.

Unindexed:

```
┌─────────┬────────┬────────┬────────┬────────┬──────────┬──────────┬────────┐
│ Stat    │ 2.5%   │ 50%    │ 97.5%  │ 99%    │ Avg      │ Stdev    │ Max    │
├─────────┼────────┼────────┼────────┼────────┼──────────┼──────────┼────────┤
│ Latency │ 349 ms │ 635 ms │ 775 ms │ 802 ms │ 632.5 ms │ 90.73 ms │ 846 ms │
└─────────┴────────┴────────┴────────┴────────┴──────────┴──────────┴────────┘
┌───────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ Stat      │ 1%      │ 2.5%    │ 50%     │ 97.5%   │ Avg     │ Stdev   │ Min     │
├───────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│ Req/Sec   │ 68      │ 68      │ 76      │ 86      │ 76.41   │ 5.22    │ 68      │
├───────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│ Bytes/Sec │ 49.1 kB │ 49.1 kB │ 54.9 kB │ 62.1 kB │ 55.2 kB │ 3.77 kB │ 49.1 kB │
└───────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
814 requests in 10.06s, 552 kB read
```

Indexed:

```
┌─────────┬────────┬────────┬────────┬────────┬───────────┬──────────┬────────┐
│ Stat    │ 2.5%   │ 50%    │ 97.5%  │ 99%    │ Avg       │ Stdev    │ Max    │
├─────────┼────────┼────────┼────────┼────────┼───────────┼──────────┼────────┤
│ Latency │ 131 ms │ 159 ms │ 195 ms │ 199 ms │ 159.58 ms │ 16.78 ms │ 216 ms │
└─────────┴────────┴────────┴────────┴────────┴───────────┴──────────┴────────┘
┌───────────┬────────┬────────┬────────┬────────┬────────┬─────────┬────────┐
│ Stat      │ 1%     │ 2.5%   │ 50%    │ 97.5%  │ Avg    │ Stdev   │ Min    │
├───────────┼────────┼────────┼────────┼────────┼────────┼─────────┼────────┤
│ Req/Sec   │ 289    │ 289    │ 310    │ 324    │ 310.61 │ 11.86   │ 289    │
├───────────┼────────┼────────┼────────┼────────┼────────┼─────────┼────────┤
│ Bytes/Sec │ 209 kB │ 209 kB │ 224 kB │ 234 kB │ 224 kB │ 8.55 kB │ 209 kB │
└───────────┴────────┴────────┴────────┴────────┴────────┴─────────┴────────┘
3k requests in 10.05s, 2.24 MB read
```

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It re-ran the indexed `EXPLAIN` (same plan, 25.1 ms vs the pasted 23.1), dry-ran the fixture SQL on a scratch database built from `migrations/` + seed, ran smoke green and red, and checked autocannon's JSON against its printed summary.
**Verdict:** NEEDS WORK → fixed → re-reviewed (the reviewer re-ran typecheck, lint, the migration tests and smoke on `18388e9`) → **SAFE TO MERGE**

| Finding                                                                     | Severity | Resolution                                                      |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| "Half CPU, not I/O" contradicted by the pasted plans (buffers rose)         | Critical | Rewritten: entirely CPU, with the buffer arithmetic             |
| "requests" row: sent-not-completed, and "3 000" never observed              | Critical | Row deleted; "mean" row added from the observed Avg column      |
| CI health wait never fails on its own                                       | Major    | Explicit final check, `cat api.log`, `exit 1`; verified locally |
| `CLUSTER` named where a partial covering index is the real alternative      | Major    | Both sides written into §1; migration unchanged by design       |
| Little's law gives the mean, not p50                                        | Minor    | Compared against the mean                                       |
| Sub-plan buffers are summed over loops                                      | Minor    | "~7 pages per tier"                                             |
| `expect(...).toBeDefined()` does not narrow                                 | Minor    | Explicit throw                                                  |
| Smoke imports `src/…/seed.ts`; cannot run against a packaged system         | Minor    | Kept — single source of truth for the id; noted here            |
| Fixture sells the box office out                                            | Minor    | Said in the fixture paragraph                                   |
| `CREATE INDEX` without `CONCURRENTLY` is right (runner wraps files in a tx) | —        | No change                                                       |

Findings deliberately **not** fixed: the smoke import of `seed.ts` (above).

---

## 6. Failure modes, as built

- **Redis down:** smoke cannot tell yet; `/health` has no Redis check until TB-017, and the test name says so.
- **Postgres down:** smoke #1 fails (`/health` 503); CI's health gate never passes and the step prints `api.log` and exits 1.
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** smoke is read-only; `pnpm migrate` applies `006` once (tested). The fixture SQL is not idempotent and says so.
- **Dies halfway through:** migration `006` is one transaction — both indexes or neither. The fixture leaves partial rows; drop and re-seed.
- **The benchmark lies if:** compared across machines (§1 carries its own machine line, distinct from the file header's laptop), or if a later row is compared against the unindexed number instead of the indexed one (§1 says which to use).

---

## 7. What I'd do differently

Read the numbers before writing the sentence about them. Both Critical findings were claims that the pasted output two paragraphs up already disproved; the data was right and the prose was not.

---

## 8. Follow-ups left behind

- [ ] **TB-014:** turn `it.todo("the web app's root HTML is served")` into a real assertion.
- [ ] **TB-022 / TB-025:** turn `it.todo("POST /holds …")` into a real 201 assertion; **TB-023:** the `DELETE /holds/:token` one.
- [ ] **TB-017:** smoke #1 asserts `redis: "ok"` as well.
- [ ] **TB-022:** when writing the counter-rebuild query, measure `holds (tier_id) INCLUDE (qty) WHERE status = 'active'` against the composite (BENCHMARKS §1, second note).
- [ ] **TB-018 / TB-019:** §2 compares against the _indexed_ row (23.1 ms / 310.6 req/s / mean 159.6 ms), same machine line.
- [ ] **TB-033:** the outbox migration is `007`, not the handbook sketch's `006`.
- [ ] The dev database in this session still holds the 200 000-row fixture; a UI pointed at it (TB-014) shows every jazz tier sold out. Drop and `pnpm migrate && pnpm seed` before TB-014.
