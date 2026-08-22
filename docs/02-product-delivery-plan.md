# Ticketbox — Delivery Plan

**Author role:** Product Manager
**Companion document:** `01-tech-lead-architecture-and-standards.md` — read Part 1 (what we're building) and Part 2 (architecture) before starting TB-001.

---

## How to use this document

Every task below is **one pull request**. Each has an ID, a size, its dependencies, what "done" means, and which tests must ship with it.

**Rules of engagement**

- One task = one branch = one PR = one squash merge. Branch naming: `feat/TB-022-lua-create-hold`.
- A PR is not done until CI is green and the listed tests exist and pass.
- Tasks marked **SPIKE** are throwaway experiments. They are _not merged_. Their deliverable is a written entry in `docs/NOTES.md`. They exist because some things must be experienced before they're understood.
- Sizes: **S** ≈ under 1 hour, **M** ≈ 1–3 hours, **L** ≈ 3–5 hours.
- Don't skip ahead. The dependency chain is real — several tasks are deliberately set up by an earlier one.

**Total: 42 tasks across 10 stages. Estimated 40–50 hours.** I think that's three to five weeks of evenings at a realistic pace, and I'd rather you take six weeks and do the concurrency tests properly than rush it in two.

**One piece of advice on sequencing:** Stage 5 is the heart of the project. Stages 0–4 exist to make Stage 5 meaningful. If you're short on time, cut Stages 8–10 before you cut anything in Stage 5.

---

## Milestone overview

| Stage | Theme                            | Tasks      | Size | Demo-able outcome                                |
| ----- | -------------------------------- | ---------- | ---- | ------------------------------------------------ |
| 0     | Foundations                      | TB-001…005 | ~6h  | `docker compose up` works, CI is green           |
| 1     | Domain core, zero infrastructure | TB-006…009 | ~5h  | Business rules unit-tested with no database      |
| 2     | Postgres + read API              | TB-010…013 | ~6h  | `GET /events/:id` returns real data              |
| 3     | UI shell                         | TB-014…016 | ~5h  | You can browse events in a browser               |
| 4     | Caching                          | TB-017…019 | ~4h  | Same page, measurably faster                     |
| 5     | **Holds — the core** ⭐          | TB-020…025 | ~9h  | **Click a button, watch a countdown**            |
| 6     | Expiry & reconciliation          | TB-026…028 | ~5h  | Abandoned carts return to the pool by themselves |
| 7     | Checkout & safety                | TB-029…032 | ~6h  | You can actually buy a ticket, exactly once      |
| 8     | Async confirmation               | TB-033…036 | ~6h  | Orders confirmed by a background worker          |
| 9     | Live updates                     | TB-037…038 | ~3h  | Two tabs update simultaneously                   |
| 10    | Hardening                        | TB-039…042 | ~5h  | It survives Redis being switched off             |

---

# Stage 0 — Foundations

**Goal:** a repository where the pipeline is green and both databases start. No features.

### TB-001 · Repository scaffold `M`

**Why:** every later task assumes strict TypeScript and enforced formatting. Retrofitting is painful.
**Scope:** pnpm workspace with `packages/api` and `packages/web`. TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. ESLint + Prettier, `--max-warnings 0`. Vitest configured with separate `unit` and `integration` projects. Husky + lint-staged pre-commit. Conventional Commits enforced by commitlint.
**Acceptance:** `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` all run and pass on an empty suite. A commit with a bad message is rejected.
**Tests:** one trivial unit test proving the runner works.

### TB-002 · Docker compose stack `S`

**Why:** everything downstream needs both engines running locally.
**Scope:** `postgres:16-alpine`, `redis:7-alpine`, `redis/redisinsight:latest`. Named volumes. Redis with `--appendonly no` for now (TB-040 changes this). `.env.example`.
**Acceptance:** `docker compose up -d` gives three healthy containers. `redis-cli ping` and `psql -c 'select 1'` both succeed. RedisInsight opens at `:5540` and connects.
**Tests:** none (infrastructure).

### TB-003 · Typed configuration `S` · needs TB-001

**Why:** a missing env var should crash at boot with a clear message, not produce a mysterious `undefined` three layers deep.
**Scope:** `main/config.ts` parsing `process.env` through a Zod schema. Exports a frozen typed object. Throws on start with a readable list of what's missing.
**Acceptance:** deleting `DATABASE_URL` produces an immediate, legible error.
**Tests:** **unit** — valid env parses; missing var throws; malformed port throws.

### TB-004 · Migrations and seed data `M` · needs TB-002, TB-003

**Why:** we need a schema and something to look at.
**Scope:** a ~30-line runner reading `migrations/*.sql` in order, tracked in `schema_migrations`. Migrations for `events`, `ticket_tiers`, `holds`, `orders`, `order_items`. Seed script: 3 events, 3 tiers each, quantities 50 / 200 / 1000, one tier deliberately at 0 so "sold out" is visible in the UI.
**Acceptance:** `pnpm migrate && pnpm seed` is idempotent — running twice does no harm.
**Tests:** **integration** — migrate an empty database, assert tables exist; run twice, assert no error.

### TB-005 · CI pipeline `M` · needs TB-001, TB-004

**Why:** the quality gates in the handbook are worthless unless they block a merge.
**Scope:** GitHub Actions: `typecheck → lint → test:unit → build`, plus a job that spins up compose, migrates, seeds, and runs `test:integration`. Branch protection requiring green CI.
**Acceptance:** a PR with a lint error cannot merge.
**Tests:** none new; this task runs the existing ones.

---

# Stage 1 — Domain core, zero infrastructure

**Goal:** the business rules of Ticketbox, fully tested, with no database in sight. I think this is the stage that will feel strangest and teach you the most about Clean Architecture.

### TB-006 · Entities and value objects `L` · needs TB-001

**Why:** Layer 1. Everything else exists to serve these.
**Scope:** `Money` (integer cents, no floats), `Quantity` (≥1, ≤10 per hold), `HoldToken`, branded `EventId` / `TierId` / `OrderId`. Entities `Event`, `TicketTier`, `Hold`, `Order`. Behaviour on the entities: `TicketTier.canFulfil(qty)`, `Hold.isExpired(now)`, `Hold.remainingMs(now)`, `Order.total()`. Domain error classes.
**Constraint:** this folder imports **nothing**. Not Zod, not a date library, nothing.
**Acceptance:** the boundary lint rule (TB-009) will later prove this; for now, check by eye.
**Tests:** **unit**, exhaustive. Money arithmetic never floats. Quantity rejects 0, -1, 11. `Hold.isExpired` at exactly the boundary instant, one ms before, one ms after. `Order.total()` across mixed tiers.

### TB-007 · Ports `M` · needs TB-006

**Why:** these interfaces are the contract between business logic and the outside world.
**Scope:** `EventRepository`, `TicketTierRepository`, `HoldStore`, `HoldRepository`, `OrderRepository`, `Clock`, `TokenGenerator`, `EventPublisher`. Interfaces only, no implementations.
**Acceptance:** no port name contains a technology word. If you typed `Redis` or `Sql`, rename it.
**Tests:** none (types only).

### TB-008 · First use cases plus in-memory fakes `L` · needs TB-007

**Why:** proves the architecture works before any adapter exists.
**Scope:** `GetEventAvailabilityUseCase` and `CreateHoldUseCase`. In `test/fakes/`: `InMemoryHoldStore`, `InMemoryEventRepository`, `FakeClock` (with `advance(ms)`), `FixedTokenGenerator`. Test data builders (`aTier().withRemaining(10).build()`).
**Acceptance:** `CreateHoldUseCase` runs green with zero infrastructure. `pnpm test:unit` finishes in under 2 seconds.
**Tests:** **unit** — creates a hold when inventory allows; rejects when `qty > remaining`; rejects a nonexistent tier; hold expiry is exactly `now + ttl` using `FakeClock`; two sequential holds reduce availability correctly.

### TB-009 · Architecture boundary enforcement `S` · needs TB-008

**Why:** the Dependency Rule that is merely written down will be broken within a week.
**Scope:** ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`): `domain/**` imports only `domain/**`; `application/**` may not import `ioredis`, `pg`, `fastify`; only `main/composition.ts` may import concrete adapters.
**Acceptance:** adding `import Redis from 'ioredis'` to a use case fails lint. **Try it, watch it fail, then revert** — an unverified rule isn't a rule.
**Tests:** none; the linter is the test.

---

# Stage 2 — Postgres and the read API

**Goal:** `GET /events/:id` returns real seeded data over HTTP.

### TB-010 · PgEventRepository `L` · needs TB-007, TB-004

**Why:** first Layer 3 adapter.
**Scope:** `pg` Pool, hand-written SQL, row → entity mappers. `findById`, `findWithTiers`, `listUpcoming`. Availability computed in SQL as `total_qty − sold − active holds`. **Leave it unindexed for now** — TB-013 needs a slow baseline.
**Acceptance:** returns domain entities, never raw rows. No `pg` type escapes the file.
**Tests:** **integration** against real Postgres — finds a seeded event with tiers; returns null for an unknown ID; availability maths is correct with holds and orders present; a tier with 0 remaining reports 0, never negative.

### TB-011 · HTTP layer and controller `M` · needs TB-010

**Why:** something to call.
**Scope:** Fastify server. `presentation/dto` Zod request/response schemas. `EventController` mapping DTO ↔ use case. Routes `GET /events`, `GET /events/:id`, `GET /health` (checking both engines independently). `x-response-time` header.
**Acceptance:** the controller contains no `if` about domain rules. A malformed UUID returns 400 from schema validation, not from a thrown error deeper in.
**Tests:** **integration** — 200 with the expected body shape; 404 for unknown ID; 400 for a malformed ID; `/health` reports each dependency separately.

### TB-012 · Composition root and error mapping `M` · needs TB-011

**Why:** one readable place where the whole system is assembled.
**Scope:** `main/composition.ts` wiring every concrete class. A single Fastify error handler mapping `DomainError` subclasses to status codes. `pino` structured logging with a correlation ID per request.
**Acceptance:** `composition.ts` reads top to bottom as a map of the system. No `reply.code(4xx)` anywhere outside the error handler.
**Tests:** **integration** — a thrown `TierNotFound` yields 404 with a consistent error envelope; an unexpected error yields 500 and does _not_ leak a stack trace to the client.

### TB-013 · Smoke suite and the performance baseline `M` · needs TB-012

**Why:** you cannot claim Redis made anything faster without a number from before.
**Scope:** the 6-assertion smoke suite from handbook §4.1. Then: `EXPLAIN (ANALYZE, BUFFERS)` on the availability query, recorded in `docs/BENCHMARKS.md`; add the composite index; re-run and record again; `autocannon -c 50 -d 10` before and after the index.
**Acceptance:** `BENCHMARKS.md` has an "unindexed" and an "indexed" row with real numbers and your own commentary.
**Tests:** **smoke** — all 6.
**Note:** this is the control experiment. I think it's the most quietly important task in the plan — it's what stops you from crediting Redis with a win that belonged to an index.

---

# Stage 3 — UI shell

**Goal:** browse events in a browser. No holds yet.

### TB-014 · Vite React app with two pages `L` · needs TB-011

**Scope:** Vite + React + TS in `packages/web`. Event list page and event detail page. Plain CSS, one stylesheet. Loading and error states. Vite dev proxy to the API.
**Acceptance:** `pnpm dev:web` shows seeded events with tiers, prices, and availability. Zero business logic in components.
**Tests:** none yet (TB-016 covers it).

### TB-015 · Typed API client `S` · needs TB-014

**Why:** the UI shouldn't hand-roll `fetch` in every component.
**Scope:** `web/src/api/client.ts` with typed functions per endpoint, sharing the response DTO types with the API package. Central error handling.
**Acceptance:** no raw `fetch` call outside `api/`.
**Tests:** **unit** — client parses a success response; surfaces a 404 as a typed error.

### TB-016 · First E2E `M` · needs TB-014, TB-015

**Scope:** Playwright configured against the compose stack. **E2E-1:** load the home page → see the event list → click an event → see three tiers with availability numbers.
**Acceptance:** `pnpm test:e2e` passes locally and in CI.
**Tests:** **E2E-1.**

---

# Stage 4 — Caching

**Goal:** the same page, measurably faster, with no route handler changed.

### TB-017 · Redis client and key registry `S` · needs TB-002, TB-003

**Scope:** `ioredis` singleton with lifecycle logging (`connect`, `ready`, `error`, `reconnecting`). `infrastructure/redis/keys.ts` exporting key-building functions with a `ticketbox:v1:` prefix.
**Acceptance:** `/health` reports Redis status. Killing the container leaves the process alive.
**Tests:** **integration** — client connects, `set`/`get` round-trips, key builders produce the documented shapes.

### TB-018 · CachedEventRepository decorator `L` · needs TB-017, TB-010

**Why:** the cleanest demonstration in the project that a good boundary lets you add infrastructure invisibly.
**Scope:** `CachedEventRepository implements EventRepository`, wrapping another `EventRepository`. JSON serialisation; **deserialise back through a Zod schema** because cached data is untrusted input. 300s TTL. Explicit `DEL` on writes. Wire it in the composition root **only**.
**Acceptance:** **zero changes to any controller or use case in this PR.** If the diff touches `presentation/` or `application/`, the pattern was implemented wrong — reject your own PR.
**Tests:** **unit** with a fake inner repo — miss then hit; the inner repo is called exactly once for two reads; a Zod parse failure is treated as a miss, never a 500. **Integration** with real Redis — the key exists with the right TTL; invalidation removes it.

### TB-019 · Stampede protection, negative caching, stats `M` · needs TB-018

**Why:** naive cache-aside has a cliff under concurrency.
**Scope:** single-flight — one caller wins a short `SET NX` mutex and refreshes while others wait and re-read. Negative caching of "not found" for 30s. Hit/miss counters via `INCR`, exposed at `GET /_stats`.
**Acceptance:** `BENCHMARKS.md` gains a "cached" row, compared honestly against the **indexed** baseline, not the unindexed one.
**Tests:** **integration** — 50 concurrent requests to a cold key call the inner repository exactly once; an unknown ID hits Postgres once, then serves from the negative cache.

### TB-019a · SPIKE: cache invalidation failures `S` · needs TB-018

**Not merged.** Comment out invalidation, update an event's name directly in `psql`, watch the API serve stale data for five minutes. Then refresh a cached key with a plain `SET` (no `EX`) and check `TTL` — confirm the key is now immortal, as the handbook describes. Write both up in `docs/NOTES.md`.

---

# Stage 5 — Holds ⭐ THE CORE

**Goal:** click a button, see a countdown, watch inventory move. This is the product.

### TB-020 · Hold use cases against in-memory fakes `M` · needs TB-008

**Why:** define correct behaviour before any Redis exists to muddy it.
**Scope:** finish `CreateHoldUseCase`; add `ReleaseHoldUseCase` and `GetHoldUseCase`. All against `InMemoryHoldStore` and `FakeClock`.
**Acceptance:** the full hold lifecycle is specified in unit tests with no infrastructure.
**Tests:** **unit** — create reduces availability; release restores it; releasing twice restores only once (**idempotency, specified here first**); an expired hold cannot be released; a hold beyond the max quantity is rejected.

### TB-021 · SPIKE: prove the race condition `M` · needs TB-020

**Not merged. This is the most important 90 minutes of the project.**
Write a naive `RedisHoldStore`: `HGET` remaining → check in TypeScript → `HINCRBY -qty`. Then write a concurrency test: 200 simultaneous requests for a tier with 10 remaining. **Watch it oversell.** Record the exact numbers in `docs/NOTES.md` — how many succeeded, what the final counter said, whether it went negative.
Do not proceed to TB-022 until you have seen this fail with your own eyes. Reading that read-then-write isn't atomic is forgettable; selling 34 tickets from a pool of 10 is not.

### TB-022 · Lua-backed RedisHoldStore `L` · needs TB-021

**Why:** the fix, and the centrepiece of the project.
**Scope:** `scripts/lua/create_hold.lua` doing atomically: read remaining → return `-1` if insufficient → `HINCRBY` availability down → `HSET` the hold hash → `PEXPIRE` 120s → `ZADD` the token to the tier's expiry index. Registered via `defineCommand`. `RedisHoldStore implements HoldStore`. A header comment on the script explaining precisely which race it prevents.
**Acceptance:** the TB-021 concurrency test now passes with exact numbers.
**Tests:** **integration** — the script decrements correctly; refuses when insufficient; sets the TTL within tolerance; adds to the ZSET. **Concurrency** — 200 parallel requests for 10 tickets: exactly 5 succeed (2 each), final availability is exactly 0, never negative. Run it 20 times in a loop; a concurrency test that passes once proves nothing.

### TB-023 · Release with compare-and-restore `M` · needs TB-022

**Why:** the obvious release implementation double-credits inventory.
**Scope:** `release_hold.lua` — only restore if the hold key still exists; delete it and remove it from the ZSET in the same script. `DELETE /holds/:token`.
**Acceptance:** calling release twice restores inventory once.
**Tests:** **integration** — release restores the exact quantity; double release restores once; releasing an unknown token is a no-op returning `{released: false}`; releasing an already-expired hold doesn't restore (the sweeper owns that, per TB-026).

### TB-024 · Postgres hold mirror `M` · needs TB-022

**Why:** Redis holds the live truth; Postgres keeps the audit trail. Making that split explicit is the lesson.
**Scope:** `PgHoldRepository` writing hold rows with status `active | converted | expired | released`. `CreateHoldUseCase` writes to both. **Write an ADR** explaining why the mirror is not the source of truth and what happens when the two disagree.
**Acceptance:** a hold appears in both stores; the ADR exists.
**Tests:** **integration** — creating a hold writes a Postgres row with status `active`; releasing updates it to `released`.

### TB-025 · Hold UI with countdown `L` · needs TB-023, TB-014

**Scope:** quantity picker and "Get tickets" on the event page; a checkout page at `/checkout/:token` showing the countdown from the server-provided `expiresAt`, an order summary, and a "Release" button. At zero, the UI re-fetches rather than assuming the hold is dead.
**Acceptance:** you can click, see the number drop, see a timer tick, and release the hold to see it go back up. **This is the first moment the project feels real.**
**Tests:** **E2E-2 (partial)** — get tickets, land on checkout, see a timer counting down, release, and confirm availability is restored.

---

# Stage 6 — Expiry and reconciliation

**Goal:** an abandoned cart returns its tickets to the pool by itself. This is the hardest correctness problem in the project.

### TB-026 · Expired-hold sweeper `L` · needs TB-023

**Why:** when the hold key expires, **nothing has given the inventory back.** Redis does not compensate for you.
**Scope:** `ReleaseExpiredHoldsUseCase` in the application layer. A worker running every 5s: `ZRANGEBYSCORE tier:{id}:holds -inf now`, then for each token a Lua script that restores inventory, removes the ZSET member, and marks the Postgres row `expired` — **idempotently**, so running it twice cannot double-restore.
**Acceptance:** create a hold with a 3s TTL, wait 8s, watch availability return on its own.
**Tests:** **unit** — the use case with `FakeClock` and fakes, including "sweeping twice restores once". **Integration** — a real short TTL restores inventory; two sweepers running concurrently restore exactly once.

### TB-027 · Reconciliation endpoint `M` · needs TB-026

**Why:** your escape hatch for when Redis and Postgres disagree — and one day they will.
**Scope:** `POST /_admin/reconcile/:eventId` recomputing availability from Postgres and overwriting Redis. Report the drift found.
**Acceptance:** after `FLUSHDB`, one call restores correct availability.
**Tests:** **integration** — flush Redis, reconcile, assert availability matches the Postgres computation; introduce artificial drift and assert it's reported and corrected.

### TB-028 · SPIKE: keyspace notifications and the FLUSHDB drill `M` · needs TB-027

**Not merged.** Two experiments, both written up in `docs/NOTES.md`:

1. Enable `notify-keyspace-events Ex`, subscribe to expiry events, then disconnect the subscriber for 20 seconds and reconnect. Record exactly what you missed. This is why the ZSET sweeper exists rather than an event listener.
2. Create 20 holds, `FLUSHDB`, and observe what your availability now claims. Then reconcile. This is your "Redis restarted in production" rehearsal.
   Also note the timing: expiry notifications fire when the key is _actually removed_, which — per the handbook's expiry section — is not necessarily the instant the TTL passed.

### TB-028a · E2E: the expiry journey `S` · needs TB-026

**Scope:** **E2E-3** — get tickets, let the timer run out, assert availability returns to its original value without any user action. Use a test-only short TTL via config.
**Tests:** **E2E-3.**

---

# Stage 7 — Checkout and safety

**Goal:** you can actually buy a ticket, exactly once, even if you double-click.

### TB-029 · ConfirmOrder use case `L` · needs TB-020, TB-024

**Scope:** `ConfirmOrderUseCase` — validate the hold is still alive, create `orders` + `order_items` in one Postgres transaction, mark the hold `converted`, and consume it in Redis so the sweeper won't restore it. `UNIQUE` constraint on `orders.idempotency_key`. `POST /orders`.
**Acceptance:** confirming a live hold produces an order; confirming an expired hold returns 410 Gone.
**Tests:** **unit** — expired hold rejected; already-converted hold rejected; total computed correctly. **Integration** — the order and items land in one transaction; a mid-transaction failure leaves no partial order.

### TB-030 · Redis idempotency layer `M` · needs TB-029

**Why:** users double-click. Networks retry. Neither should charge twice.
**Scope:** `Idempotency-Key` header required on `POST /orders`. `SET idem:{key} "in-progress" NX EX 86400`; the winner processes and overwrites with the serialised response; a loser gets 409 while in progress, or a replay with `Idempotency-Replayed: true` once complete. Store a body hash — same key with a different body returns 422.
**Acceptance:** keep the Postgres `UNIQUE` constraint too. Bypass Redis deliberately and confirm Postgres still refuses the duplicate. **Both layers, on purpose:** constraint for truth, Redis for speed.
**Tests:** **integration** — 10 concurrent requests with the same key produce exactly one order row; a replay returns the identical body; the same key with a different body returns 422.
**Tests:** **E2E-5** — double-click Confirm rapidly, exactly one order.

### TB-031 · Distributed lock, and the Postgres comparison `M` · needs TB-017

**Why:** locks are the coordination primitive people most often get subtly wrong.
**Scope:** `RedisLock implements Lock` — `SET key <uuid> NX PX 5000`, released by a Lua compare-and-delete. A fencing token via `INCR`. Used for a bulk tier restock operation, **not** on the hold path (Lua already made that atomic). Then implement the same restock with `pg_advisory_xact_lock()` and write an ADR comparing them.
**Acceptance:** the ADR names at least one failure mode each approach has that the other doesn't.
**Tests:** **integration** — two concurrent lock attempts, only one wins; the lock auto-expires; **releasing a lock you no longer own does not delete someone else's** (write the naive bare-`DEL` version first, watch this test fail, then fix it).

### TB-032 · Rate limiter `M` · needs TB-017

**Scope:** sliding window in a single Lua script (`ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` → `EXPIRE`). Fastify `preHandler`, returning 429 with `Retry-After`. Applied to `POST /holds` and `POST /orders`.
**Acceptance:** exceeding the limit returns 429; the window slides correctly rather than resetting in fixed buckets.
**Tests:** **integration** — N requests pass, N+1 is limited, and after the window passes requests succeed again. **Plus a deliberate negative test:** implement it as separate `INCR` + `EXPIRE`, kill the process between them, and find the immortal key with `TTL`. Record it in NOTES, then keep the single-script version.

---

# Stage 8 — Async confirmation

**Goal:** order confirmation happens in a background worker, reliably, even when the worker crashes mid-job.

### TB-033 · Outbox table and relay `L` · needs TB-029

**Why:** writing to Postgres and publishing to Redis are two separate writes, and the second can fail after the first commits. This is the dual-write problem, and the outbox is the honest fix.
**Scope:** `outbox` table. `ConfirmOrderUseCase` writes the order and the outbox row **in the same transaction**. A relay polls unpublished rows every second and publishes them. **The relay's claim query uses `FOR UPDATE SKIP LOCKED`** so two relay instances don't fight.
**Acceptance:** you have now built a Postgres queue and are about to build a Redis one. Write an ADR comparing them.
**Tests:** **integration** — the order and outbox row commit atomically; two concurrent relays never claim the same row; a failed publish leaves the row unpublished for retry.

### TB-034 · Stream publisher `S` · needs TB-033

**Scope:** `StreamPublisher implements EventPublisher` using `XADD` with `MAXLEN ~ 10000`.
**Tests:** **integration** — the entry lands with the right fields; `MAXLEN` trims as expected.

### TB-035 · Worker with a consumer group `L` · needs TB-034

**Scope:** separate worker process. `XGROUP CREATE … $ MKSTREAM`. Loop on `XREADGROUP … BLOCK 5000 COUNT 10 STREAMS … >`, process, `XACK`. Handlers must be idempotent — the same message _will_ arrive twice.
**Acceptance:** running two worker instances splits the work between them.
**Tests:** **integration** — a message is consumed and acked; the same message processed twice produces one side effect; two consumers split a batch with no duplicates.

### TB-036 · Recovery, DLQ, and observability `L` · needs TB-035

**Why:** the pending-entries machinery is the entire reason to choose Streams over Pub/Sub. If you don't build this, you've built Pub/Sub with extra steps.
**Scope:** `XAUTOCLAIM` pass reclaiming entries idle over 30s. After 3 delivery attempts, `XADD` to a DLQ stream and ack the original. `GET /_admin/stream` exposing `XINFO GROUPS`, the `XPENDING` summary, and DLQ length. Surface it on the `/debug` UI page.
**Acceptance:** kill a worker mid-processing before its ack; watch `XPENDING` hold the entry; watch `XAUTOCLAIM` recover it. Then do the same with Pub/Sub and watch the message be gone forever. **That contrast is the lesson of this stage.**
**Tests:** **integration** — a simulated crash leaves the entry pending; `XAUTOCLAIM` reassigns it; three failures route it to the DLQ; a second consumer group sees every message independently.

---

# Stage 9 — Live updates

**Goal:** two tabs, one number, updating simultaneously.

### TB-037 · Pub/Sub and SSE `M` · needs TB-022

**Scope:** `PubSubPublisher` publishing availability changes. `GET /events/:id/availability/stream` as Server-Sent Events. **A separate Redis connection for the subscriber** — a connection in subscribe mode can't run normal commands, and you should discover that by trying it. Subscribe first, buffer, _then_ send the initial snapshot, so an update landing between the two isn't lost.
**Acceptance:** `curl` the SSE endpoint and watch events arrive as you create holds from another terminal.
**Tests:** **integration** — a hold creation emits an event with the correct new count; a subscriber connecting mid-flight gets a consistent snapshot.

### TB-038 · Live UI and the multi-tab E2E `M` · needs TB-037, TB-025

**Scope:** `EventSource` in the event detail page, updating counts without a reload. Reconnect logic that **re-fetches a snapshot on reconnect** rather than assuming continuity — Pub/Sub is a hint channel, not a data channel.
**Acceptance:** open three tabs, hold tickets in a fourth, all three update.
**Tests:** **E2E-4** — two browser contexts; one holds tickets; assert the other's number drops with no reload.

---

# Stage 10 — Hardening

**Goal:** understand how it breaks.

### TB-039 · Asymmetric degradation `L` · needs TB-018, TB-022

**Why:** "Redis is down" should not mean the same thing for a cached read as for an inventory decrement.
**Scope:** a `REDIS_ENABLED=false` mode. Cached reads **fail open** — fall through to Postgres and keep serving. Holds and orders **fail closed** — return 503 with a clear message. Health endpoint reports degraded rather than dead.
**Acceptance:** with Redis stopped, browsing events still works and buying is cleanly refused. **This task is the payoff for the Dependency Rule** — it should be a small diff.
**Tests:** **integration** — with the Redis adapter faked as unavailable: reads succeed via Postgres; `POST /holds` returns 503; `/health` reports degraded. **Smoke** — add a degraded-mode smoke run.

### TB-040 · Operations experiments `L` · needs TB-039

**Not a feature PR** — merges `docs/OPERATIONS.md` plus config changes.
**Scope:**

- Set `maxmemory 20mb` with `allkeys-lru`, fill with junk, watch `evicted_keys` in `INFO stats`. Then confront the real danger: **this policy will evict your holds and locks.** Try `volatile-lru` and write down whether it fixes the design or merely narrows the blast radius.
- Switch to `noeviction`, fill it, watch writes fail with OOM.
- Compare RDB and AOF: write data, `docker kill` (not `stop`), restart, record what survived under each. Settle on a config and justify it.
- Write 100k keys, time `KEYS ticketbox:v1:hold:*` under load, watch p99 spike — that's the serialised server blocked. Rewrite with `SCAN`.
- Benchmark 1000 sequential `GET`s vs a pipeline vs one Lua script.
- Postgres side: `pg_stat_statements` for the slowest queries; `SELECT * FROM pg_locks` while holding a `FOR UPDATE` open in another session.
  **Acceptance:** `BENCHMARKS.md` has the full table — unindexed, indexed, cached, pipelined, Lua — with your commentary on where each win came from.

### TB-041 · Complete the test suites `M` · needs all E2E tasks

**Scope:** all 5 E2E specs green and stable. Smoke suite wired into CI before E2E. Fix flakes properly — no retries masking a real race.
**Acceptance:** `pnpm test:all` green three consecutive times.

### TB-042 · Coverage gates and README `M` · needs TB-041

**Scope:** enforce coverage thresholds in CI (domain + application 90%, infrastructure 70%, global 80%). Write the root README: what Ticketbox is (steal from handbook §1.2), how to run it, the architecture diagram, and a link to your ADRs.
**Acceptance:** a fresh clone can be running in under five minutes from the README alone.

---

## Progress tracker

```
Stage 0  ■□□□□              TB-001 002 003 004 005
Stage 1  □□□□               TB-006 007 008 009
Stage 2  □□□□               TB-010 011 012 013
Stage 3  □□□                TB-014 015 016
Stage 4  □□□ + spike        TB-017 018 019 019a
Stage 5  □□□□□□ (1 spike)   TB-020 021* 022 023 024 025      ⭐
Stage 6  □□□□ (1 spike)     TB-026 027 028* 028a
Stage 7  □□□□               TB-029 030 031 032
Stage 8  □□□□               TB-033 034 035 036
Stage 9  □□                 TB-037 038
Stage 10 □□□□               TB-039 040 041 042
                            * = spike, not merged
```

## Definition of done for the whole project

Not "all boxes ticked" — you're done when you can answer these without looking them up:

1. Why isn't `GET` then `SET` from your app atomic, even though Redis runs commands one at a time?
2. When does `MULTI`/`EXEC` suffice, and when do you need Lua?
3. What breaks if a lock is released with `DEL` instead of a compare-and-delete script?
4. Which Redis commands clear a key's TTL and which leave it alone?
5. A hold key expired and nobody returned the inventory. Whose job was that, and how did you make the fix safe to run twice?
6. Streams vs Pub/Sub vs Lists vs `FOR UPDATE SKIP LOCKED` — one sentence each on when you'd choose them.
7. Your eviction policy is `allkeys-lru`. What just happened to your distributed locks?
8. What's the difference between a per-statement and a per-transaction snapshot in Postgres?
9. Why isn't `SELECT COUNT(*)` O(1) under MVCC?
10. Redis goes down. Which endpoints still work, which fail, and why is the answer different for each?

---

**Sources:** none. This delivery plan is entirely my own sequencing, sizing, and scoping judgement — there is no external source behind any of it. The engine mechanics it refers to are sourced in the companion handbook.

**Assumptions:** (1) You're working solo, so tasks are sized for one person and there's no parallel-track planning. (2) You'd rather understand the domain deeply than cover more Redis surface area, so breadth was traded for the hold lifecycle. (3) Spike tasks that produce no merged code are acceptable to you — I think they're the highest-value hours here, but they will feel like wasted PRs if you're optimising for a green contribution graph.
