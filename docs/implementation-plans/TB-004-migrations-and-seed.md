# TB-004 — Migrations and seed data

**Status:** Implemented — see [`docs/tasks/TB-004-migrations-and-seed.md`](../tasks/TB-004-migrations-and-seed.md) for what actually happened, including two plan amendments the Phase 3 review forced (decisions 8–10)
**Date:** 2026-10-17
**Task:** TB-004 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-004-migrations-and-seed`
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Decisions a reviewer might push back on are listed under §3 "Decisions this plan is making" so they are easy to find.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** a ~30-line runner reading `migrations/*.sql` in order, tracked in `schema_migrations`. Migrations for `events`, `ticket_tiers`, `holds`, `orders`, `order_items`. Seed script: 3 events, 3 tiers each, quantities 50 / 200 / 1000, one tier deliberately at 0 so "sold out" is visible in the UI.

**Acceptance:** `pnpm migrate && pnpm seed` is idempotent — running twice does no harm.

**Tests:** **integration** — migrate an empty database, assert tables exist; run twice, assert no error.

**Depends on:** TB-002 (merged, PR #3), TB-003 (merged, PR #6) — confirmed merged: ☑

---

## 2. What I understand this to mean

Five hand-written SQL files at the repo root (`migrations/`, per handbook §2.4), a tiny TypeScript runner that applies the ones not yet recorded in a `schema_migrations` table, and a seed script that inserts three events with three tiers each using fixed IDs so a second run inserts nothing. `pnpm migrate` and `pnpm seed` become real root commands (the README already advertises them). Nothing reads the schema yet — `PgEventRepository` is TB-010.

The only design question is schema shape, and the handbook has already answered most of it: availability is `total_qty − sold − active holds` (§1.5, TB-010), hold status is `active | converted | expired | released` (TB-024), orders own `order_items` (TB-029). No architect agent needed; the plan is written directly, as for TB-002 and TB-003.

---

## 3. Approach

### Layers touched

| Layer                         | What changes                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                | None                                                                                                                        |
| L2 `application/**`           | None                                                                                                                        |
| L3 `infrastructure/postgres/` | New: `migrations.ts` (`runMigrations(client, dir)`), `seed.ts` (`seed(client)`) — the mechanics, importable by tests        |
| L4 `main/**`                  | New: `migrate.ts`, `seed.ts` — the CLI entry points: load `config`, open one `pg.Client`, call the L3 function, print, exit |

Splitting "mechanics" from "entry point" exists for one reason: `main/config.ts` validates `process.env` at import time (TB-003), so a test that imported the entry file directly would need the TB-003 `vi.stubEnv` + dynamic-import dance. Importing `infrastructure/postgres/migrations.ts` instead needs nothing.

### New or changed ports

None. No use case exists yet to need one.

### Redis keys / Lua scripts

None — this task is Postgres only.

### Migrations

Five files, applied in filename order. No indexes beyond primary keys — TB-010 says "leave it unindexed for now" so TB-013 has a slow baseline to measure against.

| File                              | Table          | Columns                                                                                                                                                         |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/001_events.sql`       | `events`       | `id uuid PK`, `name text`, `venue text`, `starts_at timestamptz`, `created_at`                                                                                  |
| `migrations/002_ticket_tiers.sql` | `ticket_tiers` | `id uuid PK`, `event_id → events`, `name text`, `price_cents int ≥ 0`, `total_qty int ≥ 0`, `created_at`                                                        |
| `migrations/003_holds.sql`        | `holds`        | `token text PK`, `tier_id → ticket_tiers`, `qty int > 0`, `status` CHECK in (`active`,`converted`,`expired`,`released`), `expires_at timestamptz`, `created_at` |
| `migrations/004_orders.sql`       | `orders`       | `id uuid PK`, `hold_token → holds UNIQUE`, `email text`, `total_cents int ≥ 0`, `created_at`                                                                    |
| `migrations/005_order_items.sql`  | `order_items`  | `id uuid PK`, `order_id → orders`, `tier_id → ticket_tiers`, `qty int > 0`, `unit_price_cents int ≥ 0`                                                          |

Money is integer cents everywhere (handbook: `Money` is "integer cents, no floats"). `holds.token` is the primary key because the hold token _is_ the hold's identity in Redis too (`hold:{token}`), and the Postgres row is a mirror of it (TB-024).

### The runner

```
CREATE TABLE IF NOT EXISTS schema_migrations (version text PK, applied_at timestamptz)
read migrations/*.sql, sorted by name
SELECT version FROM schema_migrations → Set
for each file not in the set:
  BEGIN → run file → INSERT version → COMMIT   (ROLLBACK and rethrow on failure)
return the list of versions applied this run
```

One migration per transaction, so a failing file leaves neither a half-applied table nor a recorded version. Postgres DDL is transactional, which is what makes this safe — worth knowing, because MySQL's is not.

### The seed

Three events, three tiers each, every row with a **fixed UUID** written in the script, inserted with `ON CONFLICT (id) DO NOTHING`. That is the entire idempotency mechanism: the second run matches every primary key and inserts zero rows. Fixed IDs also mean TB-013's smoke test can `GET /events/<known id>` without querying first.

| Event               | General    | Balcony   | VIP                    |
| ------------------- | ---------- | --------- | ---------------------- |
| Rooftop Jazz Night  | €20 · 1000 | €35 · 200 | €80 · **0 — sold out** |
| Late Night Comedy   | €15 · 1000 | €25 · 200 | €60 · 50               |
| Indie Film Marathon | €12 · 1000 | €18 · 200 | €40 · 50               |

The sold-out tier is `total_qty = 0` — the literal reading of "one tier deliberately at 0". The alternative (a tier of 50 with a seeded order of 50) would need a seeded hold and order and an email, inventing data the Scope line does not ask for.

### Decisions this plan is making

1. **`tsx` is added as a dev dependency** to run `.ts` entry points. Verified before planning: Node 22.22's built-in type stripping does _not_ resolve this repo's `import "./x.js"` convention to `x.ts` (`ERR_MODULE_NOT_FOUND`), so a loader is required. `tsx` is the standard one and TB-011's `pnpm dev:api` will need it too.
2. **`pg` + `@types/pg` are added** to `packages/api` (runtime + dev). Registry versions at planning time: `pg@8.23.1`, `@types/pg@8.23.1`, `tsx@4.23.15`.
3. **No `pool.ts` yet.** The scripts open a single `pg.Client`; a pool is TB-010's concern when there is a server to serve. Adding it now would be speculative.
4. **CLI output uses `process.stdout.write`**, not `console.log` (banned by lint) and not `pino` (TB-012 introduces it for the server). A three-line migrate script does not justify pulling in the logger one stage early.
5. **The runner does not take an advisory lock.** Two runners started _at the same instant_ could both try to apply the same file; the loser's `CREATE TABLE` fails and rolls back. The Acceptance line is about sequential re-runs, which are safe. Recorded under §6 as a known limitation rather than built.
6. **`orders.hold_token` is `UNIQUE`.** A hold converts to at most one order; this is a truth constraint, not a feature. `idempotency_key` is _not_ added here — TB-029 names it and will ship it as `006_…sql`, which also exercises "never edit a migration that has already run".
7. **Integration tests run against a dedicated database `ticketbox_test`**, per handbook §4.1 ("a dedicated Postgres database"). A small support module derives its URL from `DATABASE_URL` (swapping the database name), creates the database if it is missing, and offers `resetSchema()` (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`) so each migration test starts from genuinely empty. The transaction-rollback isolation the handbook describes does not fit migration tests, whose whole job is to commit DDL.
8. **`pnpm-workspace.yaml` gains `allowBuilds: { esbuild: true }`** _(added after Phase 3 review — it was missing from this plan)_. pnpm 11 blocks dependency install scripts by default; `tsx` depends on `esbuild`, whose postinstall installs the platform binary. Without the allow-list every `pnpm` script in the repo fails with `ERR_PNPM_IGNORED_BUILDS`. Scope: esbuild only, not a blanket allow.
9. **Seed `starts_at` is an offset from the seed run (`now() + interval`), not a calendar date** _(changed after Phase 3 review)_. The first draft used fixed dates in December 2026. `GET /events` lists _upcoming_ events (TB-010 `listUpcoming`), so after that date a fresh clone would seed an empty-looking box office — and `ON CONFLICT DO NOTHING` means re-seeding could never refresh the dates. Offsets of 7, 8 and 9 weeks keep the ids fixed (idempotency unchanged) and the events always in the future at seed time.
10. **`vitest.integration.config.ts` sets `fileParallelism: false`.** Integration test files share one real `ticketbox_test` database and the migration tests drop and recreate its schema; two files running in parallel workers would corrupt each other. Serial files, parallel-within-file is the right shape for a suite that owns a real engine.

---

## 4. Files

| File                                                        | New / Changed | Why                                                                          |
| ----------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| `migrations/001_events.sql` … `005_order_items.sql`         | New           | The schema                                                                   |
| `packages/api/src/infrastructure/postgres/migrations.ts`    | New           | `runMigrations(client, dir)`                                                 |
| `packages/api/src/infrastructure/postgres/seed.ts`          | New           | `seed(client)` with the fixed-ID data                                        |
| `packages/api/src/main/migrate.ts`                          | New           | CLI entry: config → client → `runMigrations` → print                         |
| `packages/api/src/main/seed.ts`                             | New           | CLI entry: config → client → `seed` → print                                  |
| `packages/api/test/integration/support/database.ts`         | New           | Test-database URL, create-if-missing, `resetSchema()`                        |
| `packages/api/test/integration/postgres/migrations.test.ts` | New           | The integration tests (§5)                                                   |
| `packages/api/package.json`                                 | Changed       | `migrate` / `seed` scripts; deps `pg`, `@types/pg`, `tsx`                    |
| `package.json` (root)                                       | Changed       | `migrate` / `seed` delegating to the api package                             |
| `pnpm-lock.yaml`                                            | Changed       | Lockfile for the new deps                                                    |
| `.env.example`                                              | Changed       | One comment line noting `ticketbox_test` is created by the integration tests |

Anything not in this table is out of scope — no `pool.ts`, no repository, no Fastify.

---

## 5. Test plan

| Level       | Test                                                                                             | What it would catch                                                              |
| ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Integration | migrating an empty database creates all five tables plus `schema_migrations`                     | A broken SQL file, a wrong filename order (FK to a table that doesn't exist yet) |
| Integration | migrating records every file in `schema_migrations`, in order                                    | The runner applying a file but not recording it (would re-run forever)           |
| Integration | running `runMigrations` twice applies nothing the second time and throws nothing                 | The literal Acceptance line                                                      |
| Integration | a migration that fails mid-file is rolled back and not recorded                                  | A half-applied migration being recorded as done                                  |
| Integration | seeding a migrated database inserts 3 events and 9 tiers, with exactly one tier at `total_qty 0` | Seed data drifting from the Scope line                                           |
| Integration | seeding twice leaves exactly 3 events and 9 tiers                                                | The literal Acceptance line for `pnpm seed`                                      |
| Unit        | N/A — nothing here is pure logic worth faking a client for                                       | —                                                                                |
| Concurrency | N/A — no inventory is touched; `total_qty` is a static column                                    | —                                                                                |

**How each test will be proven able to fail:** (1) remove the `INSERT INTO schema_migrations` line → the "recorded" and "twice" tests go red (second run tries to `CREATE TABLE events` again); (2) remove the `ON CONFLICT DO NOTHING` clause → "seeding twice" goes red with a duplicate-key error; (3) swap the `ROLLBACK` for nothing → the mid-file-failure test goes red.

---

## 6. Risks and failure modes

- **What if Redis is down?** Irrelevant — nothing here touches Redis.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Sequentially: safe by construction — `schema_migrations` skips applied files, `ON CONFLICT DO NOTHING` skips seeded rows. Concurrently: not protected (decision 5); the second runner fails loudly rather than corrupting anything, because each file runs in its own transaction.
- **What if it dies halfway through?** Mid-file: that file's transaction never commits, nothing is recorded, the next run re-applies it from scratch. Between files: the completed ones are recorded, the next run picks up at the first unapplied file. Mid-seed: each `INSERT` is its own statement; a crash leaves some rows present and the next run fills in the rest, because every row has a fixed ID.

---

## 7. Could Postgres already do this?

N/A — no Redis capability is being added. The inverse question is the interesting one: _could Redis do this?_ No — this is Kind A data (handbook §1.4): what exists, what was sold. It must survive a restart, which is exactly what Redis is not for.

---

## 8. Open questions

None blocking. The one judgment call a reviewer might disagree with is decision 7 (a `ticketbox_test` database created by the tests themselves rather than by compose). It is reversible at any time by adding a `POSTGRES_MULTIPLE_DATABASES`-style init script to compose.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed. Schema shape follows the handbook; no Redis/Postgres mechanism decision was made.
- ☑ Task doc — `docs/tasks/TB-004-migrations-and-seed.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
