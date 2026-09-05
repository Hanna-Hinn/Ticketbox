# TB-004 — Migrations and seed data

**Status:** Draft
**Date:** 2026-09-05
**Task:** TB-004 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-004-migrations-and-seed-data`
**Approved by:** _(leave blank until a human writes their name here)_
**Approved on:**

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** a ~30-line runner reading `migrations/*.sql` in order, tracked in `schema_migrations`. Migrations for `events`, `ticket_tiers`, `holds`, `orders`, `order_items`. Seed script: 3 events, 3 tiers each, quantities 50 / 200 / 1000, one tier deliberately at 0 so "sold out" is visible in the UI.

**Acceptance:** `pnpm migrate && pnpm seed` is idempotent — running twice does no harm.

**Tests:** **integration** — migrate an empty database, assert tables exist; run twice, assert no error.

**Depends on:** TB-002, TB-003 — both merged (confirmed: `docker-compose.yml` gives us `postgres:16-alpine` with `DATABASE_URL=postgresql://ticketbox:ticketbox@localhost:5432/ticketbox`; `packages/api/src/main/config.ts` gives us the validated `config.DATABASE_URL`). Confirmed merged: ☑

---

## 2. What I understand this to mean

A hand-rolled schema migration runner (no framework — this is a learning project and the delivery plan is explicit about "~30 lines") that applies numbered `.sql` files from a root-level `migrations/` directory in order, records which ones it has already applied in a `schema_migrations` table, and is safe to run any number of times. Five migrations, one per table, giving Ticketbox its full Postgres schema up front — even though several of these tables (`holds`, `orders`, `order_items`) won't have a real writer until much later tasks (TB-024, TB-029). Alongside it, a seed script that populates 3 events × 3 tiers with the exact quantities the Scope line names, including one tier at zero remaining, and which is itself safe to run repeatedly without duplicating or erroring.

This is the first task to touch a real database from application code, and the first task in the repo to need a real integration test against Postgres. No Redis, no domain layer, no use cases — this is schema plus two operational scripts living entirely in `main/` (Layer 4).

`engineering-backend-architect` is warranted here: this is the first genuine schema design, and it fixes decisions (money representation, ID strategy, hold-mirror shape, FK topology) that later tasks (TB-006 entities, TB-010 `PgEventRepository`, TB-024 hold mirror, TB-029 `ConfirmOrderUseCase`) will build directly on top of without revisiting.

---

## 3. Approach

### Layers touched

| Layer | What changes |
| --- | --- |
| L1 `domain/**` | None |
| L2 `application/**` | None |
| L3 `infrastructure/**`, `presentation/**` | None |
| L4 `main/**`, `worker/**` | New: `main/migrate.ts`, `main/seed.ts`, `main/logger.ts` |
| Repo root | New: `migrations/001_events.sql` … `005_order_items.sql` |

`main/` is Layer 4, which may import anything — `pg` directly, no port or adapter abstraction needed for either script.

### New or changed ports

**None.** I considered a `MigrationRunner` port and rejected it: nothing in the application ever calls this at request time — it's an operational script invoked from the command line (or CI), never injected into a use case, never faked in a unit test. "Every port needs a fake" is the test I'd apply, and I can't imagine `InMemoryMigrationRunner` being useful to anything — there's nothing upstream of it to isolate. Same reasoning for the seed script. Plain `pg` is fine here.

### Redis keys

None — this task adds no Redis capability.

### Lua scripts

None.

### Migrations

Five numbered files, `001`–`005`, leaving `006` free for the `outbox` table (`§2.4`'s folder-structure comment already reserves it — TB-033). `schema_migrations` itself is **not** a numbered migration file; the runner creates it directly (`CREATE TABLE IF NOT EXISTS`) before it can consult it, which avoids the chicken-and-egg problem of a tracking table needing to track its own creation.

```sql
-- runner bootstrap, not a numbered migration file
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `migrations/001_events.sql`

```sql
-- The event itself: what's being sold, and when it happens.
CREATE TABLE events (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `migrations/002_ticket_tiers.sql`

```sql
-- A category of ticket within an event, with its own price and quantity.
-- Availability = total_qty - sold_qty - (currently held, which lives in Redis
-- from TB-022 onward and is never persisted here).
CREATE TABLE ticket_tiers (
    id                  UUID PRIMARY KEY,
    event_id            UUID NOT NULL REFERENCES events(id),
    name                TEXT NOT NULL,
    price_minor_units   INTEGER NOT NULL CHECK (price_minor_units >= 0),
    total_qty           INTEGER NOT NULL CHECK (total_qty > 0),
    sold_qty            INTEGER NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sold_within_total CHECK (sold_qty <= total_qty)
);
```

#### `migrations/003_holds.sql`

```sql
-- The Postgres mirror of a Redis hold (TB-024). Redis is authoritative for
-- whether a hold is live right now; this table exists so the fact that a
-- hold ever happened survives a FLUSHDB, and so it's auditable afterwards.
-- Not written to until TB-024 — this migration only fixes its shape early,
-- alongside the other four tables the task asks for.
CREATE TABLE holds (
    token       UUID PRIMARY KEY,
    tier_id     UUID NOT NULL REFERENCES ticket_tiers(id),
    qty         INTEGER NOT NULL CHECK (qty > 0),
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'converted', 'expired', 'released')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    CONSTRAINT hold_expires_after_creation CHECK (expires_at > created_at)
);
```

#### `migrations/004_orders.sql`

```sql
-- A hold that got confirmed, permanent. hold_token traces every order back
-- to the exact hold it came from — the audit trail the handbook asks for.
CREATE TABLE orders (
    id                UUID PRIMARY KEY,
    hold_token        UUID NOT NULL REFERENCES holds(token),
    email             TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `migrations/005_order_items.sql`

```sql
-- Line items for an order. unit_price_minor_units is a snapshot of what was
-- actually paid at purchase time — ticket_tiers.price_minor_units can change
-- later without rewriting history. One order currently produces exactly one
-- row here (a hold is single-tier), but the table stays separate from
-- orders because the delivery plan names it as its own table and a
-- multi-tier cart shouldn't need a schema change if it ever arrives.
CREATE TABLE order_items (
    order_id                 UUID NOT NULL REFERENCES orders(id),
    tier_id                  UUID NOT NULL REFERENCES ticket_tiers(id),
    qty                      INTEGER NOT NULL CHECK (qty > 0),
    unit_price_minor_units   INTEGER NOT NULL CHECK (unit_price_minor_units >= 0),
    PRIMARY KEY (order_id, tier_id)
);
```

No `ON DELETE CASCADE` anywhere — every FK defaults to `NO ACTION`. These are Kind-A audit records; a cascading delete on `events` silently wiping `orders` is exactly the kind of thing that shouldn't be possible by accident.

No indexes beyond what the `PRIMARY KEY`/`UNIQUE` constraints create automatically. TB-010 explicitly says to "leave it unindexed for now" for the availability query, because TB-013 is the task that measures the unindexed query, adds the composite index, and re-measures — that's the whole point of TB-013's before/after benchmark. Adding an index here would spend that experiment before it happens. The sweeper's reclaimable-holds index (`idx_holds_reclaimable` on `expires_at` where unresolved) is a real future need too, but nothing queries it until TB-026 — adding it now would be exactly the "index for a query nobody runs yet" the backend-architect mandate warns against.

### Decisions this plan is making

**IDs are always supplied by the application, never generated by Postgres.** Every `id`/`token` column is `UUID PRIMARY KEY` with no `DEFAULT`. Two reasons: first, it matches the Clean Architecture shape this project is building toward — TB-006/007 already name a `TokenGenerator` port and branded ID types, which implies entities (or the use case) own identity generation, not the database; a repository should be handed an already-identified entity to persist, not asked to hand one back. Second, it sidesteps a real uncertainty I'd rather not paper over: whether `gen_random_uuid()` needs the `pgcrypto` extension on this Postgres version or is available in core depends on the exact version, and I don't have a running Postgres in this environment to check against right now (Prime Directive: don't state a Postgres semantic from memory when it's checkable). The seed script will generate its own fixed UUIDs directly in TypeScript (`node:crypto`'s `randomUUID()`, or literal constants for reproducibility — see below); nothing here depends on a Postgres-side default.

**Money as `price_minor_units` / `unit_price_minor_units`, not `price`.** CLAUDE.md's rule is "integer minor units, never floating point" — spelling that out in the column name makes the unit unambiguous to the next reader without needing a comment, and there's only one currency in scope so no separate `currency` column.

**`orders` does not store a computed total.** I considered a `total_minor_units` column, since TB-006 names `Order.total()` as domain behaviour. But storing a redundant total invites exactly the failure mode this project is explicitly wary of elsewhere ("a cache quietly became the source of truth") — a second place the total could drift from `SUM(order_items)`. `Order.total()` can be computed from the loaded `OrderItem`s instead. Orders are write-once in this project (no cancel/refund flow is in scope), so there's no later mutation to worry about desynchronising it either way — I just don't see a reason to duplicate the fact.

**`orders` has no `status` column.** Nothing in the delivery plan describes an order-level state machine (no cancel, no refund — explicitly out of scope). The glossary's own definition is "a hold that got confirmed, permanent" — a row's existence already means confirmed. Adding a `status` column with a single possible value would be exactly the "configurability nobody requested" the anti-slop rules warn about.

**`holds.status` is `TEXT` + `CHECK`, not a Postgres `ENUM` type.** A native enum is more self-documenting at the type level, but adding a fifth value later needs `ALTER TYPE ... ADD VALUE`, which has real transactional restrictions in Postgres that I'd rather not depend on getting right from memory. `TEXT` + `CHECK` is the same constraint with none of that friction, and it's the exact style CLAUDE.md's own migration example already uses (`CHECK (qty > 0)`).

**`schema_migrations` is bootstrapped by the runner, not migration `000`.** It has to exist before the runner can query it to know what's already applied, so it can't itself be one of the tracked files.

**Filenames are lexically sorted, and that's the entire ordering mechanism.** `001_events.sql` … `005_order_items.sql` sort correctly as plain strings because they're zero-padded to 3 digits. This is a real constraint on every future migration: it must keep 3-digit padding, or lexical sort silently breaks (`010` would sort before `002` without padding — not a risk yet, but worth stating since nothing enforces it except convention).

**Each migration file runs inside its own transaction, which also contains its `schema_migrations` insert.** This is the load-bearing decision for "what if it dies halfway" (§6) — see there for the race it prevents. I considered two alternatives and rejected both: one giant transaction wrapping every pending file (a later file's mistake would roll back an earlier file's already-good migration, and it doesn't match "one file, one unit of change"), and running the DDL and the tracking insert as two separate statements/transactions (a crash between them would leave a table created but unmarked, and the next run's `CREATE TABLE` would then fail against a table that already exists — breaking idempotency, the entire point of this task).

**Seed idempotency is fixed UUIDs + `INSERT ... ON CONFLICT (id) DO UPDATE`,** not "check if a row exists, then decide." Every seeded event/tier gets a literal, constant UUID (below), so re-running the script always converges to the same 3 events and 9 tiers regardless of how many times it's run or where a previous run stopped — there's no window where a partial run needs special-case resume logic.

**The whole seed script runs inside one transaction.** Not required for idempotency (the upserts are already safe individually), but it gives a clean all-or-nothing property per run instead of leaving, say, event 2 fully seeded and event 3 half-seeded visible in between if the process dies mid-run.

**A minimal `main/logger.ts` (`pino`, no correlation ID, no request scoping) is added now, ahead of TB-012.** This is the one place I'm knowingly stepping slightly past the literal Scope line, so flagging it clearly rather than sliding it in quietly: `no-console` is already `"error"` in `eslint.config.js` today (not a future TB-009 rule), and these two CLI scripts need to report what they did (which migrations ran, that seeding completed) somewhere real. The alternatives were `process.stdout.write` (technically dodges the letter of `no-console` without matching its spirit — CLAUDE.md's own fix for the ban is named as "structured logging via pino") or a scoped `eslint-disable` (CLAUDE.md bans blanket disables; a narrow one is arguably different, but still feels like working around a rule rather than following its intent). Pulling forward a bare `pino()` instance is small, and TB-012 — which explicitly owns "pino structured logging with a correlation ID per request" — can extend or replace it rather than invent it from nothing. New runtime dependency: `pino`.

**Root scripts follow the existing `pnpm -r --if-present run <name>` convention**, not `pnpm --filter @ticketbox/api`. `migrate`/`seed` only exist in `@ticketbox/api` today, but this matches exactly how `lint`, `typecheck`, and `test:unit` are already wired at the root — no reason to introduce a second convention.

**Running the scripts directly as TypeScript via `tsx`, not compiling first.** No build step exists yet for `packages/api` (TB-011+ will need one for the Fastify server); adding a compile-then-run step just for two small ops scripts would be more machinery than the task needs. New dev dependency: `tsx`.

#### The runner (`packages/api/src/main/migrate.ts`)

```ts
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations",
);

export async function migrate(pool: Pool, migrationsDir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    ran.push(file);
  }
  return ran;
}

// CLI entry point — only runs when this file is executed directly (`pnpm migrate`),
// not when `migrate()` is imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  migrate(pool)
    .then((ran) => {
      logger.info({ applied: ran }, ran.length > 0 ? "migrations applied" : "already up to date");
    })
    .catch((err: unknown) => {
      logger.error({ err }, "migration failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
```

~33 lines of actual runner logic (the exported `migrate` function), matching the Scope line's "~30-line runner"; the rest is the CLI bootstrap.

#### The seed script (`packages/api/src/main/seed.ts`)

```ts
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

interface SeedTier {
  id: string;
  name: string;
  priceMinorUnits: number;
  totalQty: number;
  soldQty: number;
}
interface SeedEvent {
  id: string;
  name: string;
  startsAt: string;
  tiers: SeedTier[];
}

// Fixed, literal UUIDs — not generated — so re-running this script always
// upserts the same 9 rows instead of creating new ones each time.
const EVENTS: SeedEvent[] = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    name: "Rooftop Jazz Night",
    startsAt: "2026-09-20T19:00:00Z",
    tiers: [
      { id: "20000000-0000-0000-0000-000000000001", name: "General", priceMinorUnits: 2000, totalQty: 1000, soldQty: 0 },
      { id: "20000000-0000-0000-0000-000000000002", name: "Balcony", priceMinorUnits: 3500, totalQty: 200, soldQty: 0 },
      // Deliberately sold out — this is the tier the delivery plan asks for.
      { id: "20000000-0000-0000-0000-000000000003", name: "VIP", priceMinorUnits: 8000, totalQty: 50, soldQty: 50 },
    ],
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    name: "Downtown Comedy Night",
    startsAt: "2026-10-03T20:00:00Z",
    tiers: [
      { id: "20000000-0000-0000-0000-000000000004", name: "General", priceMinorUnits: 1500, totalQty: 1000, soldQty: 0 },
      { id: "20000000-0000-0000-0000-000000000005", name: "Balcony", priceMinorUnits: 2500, totalQty: 200, soldQty: 0 },
      { id: "20000000-0000-0000-0000-000000000006", name: "VIP", priceMinorUnits: 4500, totalQty: 50, soldQty: 0 },
    ],
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    name: "Riverside Food Festival",
    startsAt: "2026-10-18T12:00:00Z",
    tiers: [
      { id: "20000000-0000-0000-0000-000000000007", name: "General", priceMinorUnits: 1000, totalQty: 1000, soldQty: 0 },
      { id: "20000000-0000-0000-0000-000000000008", name: "Balcony", priceMinorUnits: 1800, totalQty: 200, soldQty: 0 },
      { id: "20000000-0000-0000-0000-000000000009", name: "VIP", priceMinorUnits: 3000, totalQty: 50, soldQty: 0 },
    ],
  },
];

export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of EVENTS) {
      await client.query(
        `INSERT INTO events (id, name, starts_at) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at`,
        [event.id, event.name, event.startsAt],
      );
      for (const tier of event.tiers) {
        await client.query(
          `INSERT INTO ticket_tiers (id, event_id, name, price_minor_units, total_qty, sold_qty)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             price_minor_units = EXCLUDED.price_minor_units,
             total_qty = EXCLUDED.total_qty,
             sold_qty = EXCLUDED.sold_qty`,
          [tier.id, event.id, tier.name, tier.priceMinorUnits, tier.totalQty, tier.soldQty],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  seed(pool)
    .then(() => logger.info({ events: EVENTS.length }, "seed complete"))
    .catch((err: unknown) => {
      logger.error({ err }, "seed failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
```

#### `packages/api/src/main/logger.ts`

```ts
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
```

---

## 4. Files

| File | New / Changed | Why |
| --- | --- | --- |
| `migrations/001_events.sql` | New | `events` table |
| `migrations/002_ticket_tiers.sql` | New | `ticket_tiers` table |
| `migrations/003_holds.sql` | New | `holds` table — the Postgres hold mirror, empty until TB-024 |
| `migrations/004_orders.sql` | New | `orders` table |
| `migrations/005_order_items.sql` | New | `order_items` table |
| `packages/api/src/main/migrate.ts` | New | The runner (exported `migrate()`) plus its CLI entry point |
| `packages/api/src/main/seed.ts` | New | The seed data (exported `seed()`) plus its CLI entry point |
| `packages/api/src/main/logger.ts` | New | Minimal shared `pino` instance so the two scripts above can log without tripping `no-console` |
| `packages/api/test/integration/main/migrate.test.ts` | New | The task's named integration tests |
| `packages/api/test/integration/main/seed.test.ts` | New | Seed idempotency — required by Acceptance even though not named on the Tests line (see §5) |
| `packages/api/test/integration/helpers/testDatabase.ts` | New | Shared helper: ensures a dedicated `ticketbox_test` database exists, resets it to empty (see §5) |
| `packages/api/package.json` | Changed | New deps: `pg`, `pino` (runtime); `@types/pg`, `tsx` (dev). New scripts: `migrate`, `seed` |
| `package.json` (root) | Changed | New scripts: `migrate`, `seed`, delegating via the existing `pnpm -r --if-present run <name>` convention |

Anything not in this table is out of scope for this PR — in particular, no `domain/`, `application/`, or `infrastructure/` changes (those start at TB-006/TB-010), and no `.env.example` change (the test database URL is derived from `DATABASE_URL`, not configured separately — see §5).

---

## 5. Test plan

| Level | Test | What it would catch |
| --- | --- | --- |
| Unit | N/A | No business logic — everything here is either raw SQL or a thin script |
| Integration | See below | Migrations don't actually create the schema; running twice throws; seed duplicates or errors on replay |
| Concurrency | N/A | No inventory path exists yet — this task creates the columns TB-021/022 will later race against, but nothing writes to them concurrently here |
| Smoke | N/A — TB-013 | — |
| E2E | N/A — TB-016 | — |

**Test isolation — a deliberate divergence from the general integration convention, explained:** CLAUDE.md's testing section describes integration tests as running against "a dedicated Postgres database with each test in a transaction that rolls back." That pattern fits row-level tests (TB-010 onward) well, but doesn't fit this task: the whole point of "run twice" is that the second run has to see the first run's *committed* state, and `CREATE TABLE` is exactly the kind of statement a rollback would erase before the second run ever saw it. There's also a second, sharper reason a rollback-based test can't reuse the app's normal `ticketbox` database here at all: the CI pipeline order is `docker compose up → migrate + seed → test:integration` — by the time `test:integration` runs, the shared dev database already has the schema and seed data on it. This task's own "migrate an empty database" assertion needs a database that is actually empty, which the main `DATABASE_URL` will not be by then.

So: a dedicated `ticketbox_test` database, on the same Postgres instance, distinct from the dev database. `packages/api/test/integration/helpers/testDatabase.ts` derives its connection string from `config.DATABASE_URL` (swap the path segment), connects once via the `postgres` maintenance database to create `ticketbox_test` if it doesn't exist yet, and in each test's setup runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` against it to guarantee a genuinely empty starting point without needing a second physical database provisioned in `docker-compose.yml`. No new env var — `TEST_DATABASE_URL` isn't introduced; the helper derives it, so there's nothing new to keep in sync with `.env.example`.

Test cases:

1. **`migrate.test.ts` — "creates all five tables plus the tracking table on an empty database."** Reset `ticketbox_test` to empty, run `migrate(testPool, MIGRATIONS_DIR)`, query `information_schema.tables` and assert `events`, `ticket_tiers`, `holds`, `orders`, `order_items`, and `schema_migrations` all exist. This is the task's literal first Tests bullet.
2. **`migrate.test.ts` — "running migrate twice does not error and does not re-record an already-applied file."** Run `migrate()` once, capture `schema_migrations` row count, run it again, assert it resolves without throwing and the row count is unchanged. The task's literal second Tests bullet.
3. **`seed.test.ts` — "seeding an empty (but migrated) database inserts 3 events and 9 tiers, one at zero remaining."** Migrate, seed, query counts and assert the Rooftop Jazz Night VIP tier's `sold_qty` equals its `total_qty`.
4. **`seed.test.ts` — "running seed twice does not error and does not duplicate rows."** Seed twice, assert the same row counts as after one run, and that the row values (e.g. VIP `sold_qty`) are unchanged rather than doubled. This isn't on the task's literal Tests line, but the Acceptance line explicitly names `pnpm migrate && pnpm seed` idempotency together — a plan that only tested the migrate half wouldn't actually demonstrate Acceptance.

**How each test will be proven able to fail**, deliberately broken and reverted:

- Test 1: temporarily make `migrate()` return early before executing any file — watch the table-existence assertion go red, then restore.
- Test 2: temporarily remove the `applied.has(file)` skip check, so every run re-executes every file — the second run's `CREATE TABLE events` hits `relation "events" already exists` and the test goes red, then restore.
- Test 3: temporarily seed with `soldQty: 0` on the VIP tier — the "one tier at zero remaining" assertion goes red, then restore.
- Test 4: temporarily swap `ON CONFLICT (id) DO UPDATE` for a plain `INSERT` — the second seed run hits a primary-key violation and the test goes red, then restore.

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A — this task never touches Redis.
- **What if a key is evicted under `allkeys-lru`?** N/A — no Redis keys exist yet.
- **What if this operation runs twice?** This is the task's actual Acceptance criterion, not an edge case. Migrate: `schema_migrations` records exactly which files have run; a second invocation reads that table and skips everything already applied, so no file executes twice. Seed: every row is upserted by a fixed, literal UUID (`ON CONFLICT (id) DO UPDATE`), so re-running always converges to the same 3 events / 9 tiers rather than duplicating or erroring.
- **What if it dies halfway through?**
  - **Migrate, mid-file:** each file runs inside one transaction that also contains its `schema_migrations` insert. If the process dies before `COMMIT`, Postgres rolls the whole transaction back on connection loss — the file's DDL is undone and its row was never written, so the next run correctly sees that file as unapplied and retries it cleanly from scratch. (Postgres's DDL being transactional — `CREATE TABLE` participating in rollback like any other statement — is the load-bearing assumption here; Phase 2 will verify it directly by killing the process mid-migration and confirming the partial table is gone and a retry succeeds, rather than trusting this from memory.)
  - **Migrate, between files:** each completed file's row is already committed before the runner moves to the next file, so a restart resumes exactly at the first unapplied file — no partial state to reconcile.
  - **Seed, mid-run:** the whole script runs in one transaction; a crash before `COMMIT` leaves the database exactly as it was before the run started (whatever the previous run left, if any), and the next run replays every upsert from scratch — safe regardless of how far the interrupted run got, because every statement in it is idempotent on its own.

---

## 7. Could Postgres already do this?

N/A — the template's own instruction is that this section is "required whenever this task adds a Redis capability." This task adds none: it's schema and seed data for Postgres only. There's no Redis-vs-Postgres tradeoff to argue here, so nothing to answer both sides of.

---

## 8. Open questions

1. ~~**Should the `ticketbox_test` database strategy in §5 become the standard integration-test database for every future Postgres integration test (starting with TB-010), or is it specific to schema-level tests like this one?**~~ **Resolved by Hanna (2026-09-05): standard going forward.** The `ticketbox_test` database, reset via `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` before each test, is now the repo-wide Postgres integration-test isolation strategy, not something specific to this task. This is a **departure from CLAUDE.md's testing section**, which currently describes integration tests as running "with each test in a transaction that rolls back" against a database that's implied to already carry schema/seed data — that line should be corrected in a follow-up (flagged for Phase 5 / whichever task next touches that doc) so the written convention matches what TB-010 onward will actually do.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed. No Redis/Postgres tradeoff was decided (see §7); the schema decisions in §3 are real but are design choices within Postgres, not the kind of "why Lua over WATCH" tradeoff the ADR template exists for.
- ☑ Task doc — `docs/tasks/TB-004-migrations-and-seed-data.md` — always
- ☐ Benchmark entry — nothing measured (TB-013 owns the first measured query)
- ☐ NOTES entry — not a SPIKE task
