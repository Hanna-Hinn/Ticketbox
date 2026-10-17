# TB-004 — Migrations and seed data

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-004 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-004-migrations-and-seed.md`](../implementation-plans/TB-004-migrations-and-seed.md)
**Branch / PR:** `feat/TB-004-migrations-and-seed` · [#7](https://github.com/Hanna-Hinn/Ticketbox/pull/7)
**ADR:** none — the schema follows the handbook; no Redis/Postgres mechanism decision was made.

---

## What this task delivered

A real schema and real rows. `migrations/001_events.sql` … `005_order_items.sql` define the five Kind A tables; `pnpm migrate` applies whichever of them are not yet recorded in `schema_migrations`; `pnpm seed` inserts three events with three tiers each, one of them sold out, and inserts nothing on a second run. Nothing reads the schema yet — `PgEventRepository` is TB-010.

---

## How it works

```
pnpm migrate
  main/migrate.ts            L4: config → one pg.Client → runMigrations(client, <repo>/migrations/)
  └ infrastructure/postgres/migrations.ts
      CREATE TABLE IF NOT EXISTS schema_migrations
      readdir *.sql, sort                       ← filename order is the migration order
      SELECT version FROM schema_migrations     ← the set of already-applied files
      for each unapplied file:
        BEGIN · <file> · INSERT version · COMMIT     (ROLLBACK + rethrow on failure)

pnpm seed
  main/seed.ts               L4: config → one pg.Client → seed(client)
  └ infrastructure/postgres/seed.ts
      for each event / tier in SEED_EVENTS (fixed uuids):
        INSERT … ON CONFLICT (id) DO NOTHING   ← the entire idempotency mechanism
      starts_at = now() + '7 weeks'::interval  ← always upcoming, never a stale date
```

Two Postgres facts carry the design. **DDL is transactional**, so a migration that fails halfway (the test uses a file that creates the same table twice) leaves neither a table nor a `schema_migrations` row — the next run re-applies it from scratch. **`ON CONFLICT DO NOTHING` on a fixed primary key** makes the seed safe to re-run and safe to resume: delete one tier and re-seed, and exactly that tier comes back.

### Layers touched

| Layer                         | What changed                                    |
| ----------------------------- | ----------------------------------------------- |
| L1 `domain/**`                | None                                            |
| L2 `application/**`           | None                                            |
| L3 `infrastructure/postgres/` | New: `migrations.ts`, `seed.ts`                 |
| L4 `main/**`                  | New: `migrate.ts`, `seed.ts` (CLI entry points) |

### Key files

| File                                                     | What it does                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `migrations/001_events.sql` … `005_order_items.sql`      | The schema; CHECKs on money/quantity, status, UNIQUE on `orders.hold_token`      |
| `packages/api/src/infrastructure/postgres/migrations.ts` | `runMigrations(client, dir): Promise<string[]>`                                  |
| `packages/api/src/infrastructure/postgres/seed.ts`       | `SEED_EVENTS` and `seed(client): Promise<{ events, tiers }>`                     |
| `packages/api/src/main/migrate.ts`, `main/seed.ts`       | Load `config`, open a `pg.Client`, call the L3 function, print one line          |
| `packages/api/test/integration/support/database.ts`      | `connectToTestDatabase()` (creates `ticketbox_test` if missing), `resetSchema()` |
| `pnpm-workspace.yaml`                                    | `allowBuilds: { esbuild: true }` — see divergence 1                              |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                 | What actually happened                                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4 file table had no `pnpm-workspace.yaml`              | The first `pnpm typecheck` after adding `tsx` failed with `ERR_PNPM_IGNORED_BUILDS`: pnpm 11 refuses to run esbuild's install script unless allowed. `onlyBuiltDependencies` (the pnpm 9/10 key) did nothing — pnpm 11 reads `allowBuilds: { esbuild: true }`, found by grepping the pnpm bundle for its own error hint. The Phase 3 review flagged the file as an unrecorded plan change; the plan gained decision 8. | A workspace-wide build permission is exactly the kind of choice the plan's decision list exists to surface. Discovered mid-implementation, recorded late.                                                                                                                          |
| Seed events had fixed calendar dates (2026-12-05/12/19) | The review pointed out that `GET /events` lists _upcoming_ events, so from 2026-12-20 a fresh clone would seed an empty-looking box office, and `ON CONFLICT DO NOTHING` meant re-seeding could never fix it. `starts_at` is now `now() + '7 weeks'::interval` (8, 9 for the others); ids unchanged. A test asserts every seeded event is in the future.                                                               | A silent assumption the plan never discussed. The fix keeps idempotency intact because only the ids are compared.                                                                                                                                                                  |
| New deps pinned exact (`pg@8.23.1`)                     | Changed to caret ranges to match every other dependency in the file.                                                                                                                                                                                                                                                                                                                                                   | Review (Minor): "match existing style". Pinning was never a decision, just a side effect of `pnpm add x@version`.                                                                                                                                                                  |
| Two test files (`migrations.test.ts` + support)         | Three: migrations, seed, and a `schema.test.ts` for the CHECK/UNIQUE constraints; plus `fileParallelism: false` in the integration config.                                                                                                                                                                                                                                                                             | The review's "For the Test Phase" block asked for constraint tests ("a dropped CHECK is invisible to TypeScript and every other test") and for per-row seed idempotency. Three files sharing one real database with a schema-dropping `beforeEach` cannot run in parallel workers. |
| "~30-line runner"                                       | 35 lines including the header comment.                                                                                                                                                                                                                                                                                                                                                                                 | Close enough; the five extra are the ROLLBACK branch and the return value the tests assert on.                                                                                                                                                                                     |

---

## 4. Tests shipped

| Level       | Test file                                                   | Behaviour asserted                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `packages/api/test/integration/postgres/migrations.test.ts` | Empty DB → all six tables; every file recorded in order; second run applies `[]`; a mid-file failure is rolled back and unrecorded; an edited already-applied file is skipped (no checksum) |
| Integration | `packages/api/test/integration/postgres/seed.test.ts`       | 3 events / 9 tiers / exactly one `total_qty = 0` / no orphan tiers; second run inserts `{0, 0}`; a deleted tier is restored by re-seeding as `{0, 1}`; every `starts_at` is after `now()`   |
| Integration | `packages/api/test/integration/postgres/schema.test.ts`     | CHECKs reject `total_qty −1`, `qty 0`, `status 'bogus'`, `unit_price_cents −1`; UNIQUE rejects a second order for the same hold                                                             |
| Unit        | none — nothing here is pure logic                           | —                                                                                                                                                                                           |
| Concurrency | none — no inventory path; `total_qty` is a static column    | —                                                                                                                                                                                           |

14 tests, 1.6 s, against a real Postgres 16.

**Proven able to fail** — four sabotages, each reverted and the suite re-run green afterwards:

```
SABOTAGE 1: delete the INSERT INTO schema_migrations line
  × records every applied file in schema_migrations, in filename order
  × applies nothing and throws nothing on a second run
  × skips an already-recorded file even when its content has changed
  Tests  3 failed | 11 passed (14)

SABOTAGE 2: delete ON CONFLICT (id) DO NOTHING
  FAIL  seed.test.ts   (duplicate key on the second seed)
  FAIL  schema.test.ts (its beforeEach seeds a database the previous test already seeded)
  Test Files  2 failed | 1 passed (3)

SABOTAGE 3: delete the ROLLBACK
  × rolls back a migration that fails mid-file and does not record it
  × skips an already-recorded file even when its content has changed
  Tests  2 failed | 12 passed (14)

SABOTAGE 4: drop the holds.status CHECK from 003_holds.sql
  × rejects a hold with an unknown status
  Tests  1 failed | 13 passed (14)
```

**Coverage after this task:** not measured — nothing in `domain/` or `application/` exists yet, and the integration config does not run `--coverage`. The 70% `infrastructure/**` gate is a unit-coverage gate; these two modules are only exercised by integration tests.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool
**Verdict:** SAFE TO MERGE, conditional on two plan amendments — both made (decisions 8 and 9), seed dates changed, versions un-pinned. Not formally re-dispatched: no Critical issues, and the conditions were documentation and a seed-data change whose test the review itself specified.

| Finding                                                                                    | Severity | Resolution                                                                              |
| ------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml` changed but not in the plan's file table                             | Major    | Plan amended: decision 8 + §4 row                                                       |
| Seed `starts_at` fixed dates expire; `listUpcoming` would go empty; `DO NOTHING` can't fix | Major    | `now() + interval` offsets; plan decision 9; new test "seeds every event in the future" |
| New deps pinned exact while the file uses carets                                           | Minor    | Carets                                                                                  |
| `.env.example` comment describes Phase 4 behaviour before it existed                       | Minor    | Phase 4 built exactly that (`support/database.ts`); comment is accurate                 |
| `SeedTier`/`SeedEvent` interfaces annotate one inferable literal                           | Minor    | Kept — they document the shape at a glance                                              |
| No checksum: an edited, already-applied migration is silently skipped                      | Minor    | Not built; the behaviour is pinned by a test so the limitation is observed, not assumed |
| ROLLBACK's own error would mask the SQL error if the connection died                       | Minor    | Not changed; standard pattern, both errors say the same thing                           |

Findings deliberately **not** fixed: the checksum and the ROLLBACK masking, for the reasons above.

---

## 6. Failure modes, as built

- **Redis down:** irrelevant — nothing here touches Redis.
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** sequentially, proven by tests ("applies nothing on a second run", "inserts nothing on a second run"). Concurrently, two runners started at the same instant are not protected: the loser's `CREATE TABLE` fails and its transaction rolls back, so the outcome is a loud error, not a corrupt schema. Not tested.
- **Dies halfway through:** mid-file, proven — the probe file's second `CREATE TABLE` fails and nothing is left behind. Mid-seed, proven — deleting one tier and re-seeding restores exactly one row.

---

## 7. What I'd do differently

Look up `listUpcoming` before writing a single seed date. The reviewer found a time bomb in two months' time by reading the handbook line that names the query; the plan should have.

---

## 8. Follow-ups left behind

- [ ] `runMigrations` has no advisory lock; two concurrent runners fail loudly rather than coordinate. Fine for `pnpm migrate` and CI; revisit only if a second runner ever exists.
- [ ] No checksum on applied migrations. "Never edit a migration that has already run" is a rule, not a mechanism. Pinned by a test so a future change is deliberate.
- [ ] The integration suite runs files serially (`fileParallelism: false`). TB-010's transaction-rollback isolation will sit alongside the schema-dropping migration tests in the same database; if the suite ever slows past 30 s, split the migration tests into their own database instead of serialising everything.
