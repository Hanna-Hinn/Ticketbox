# Ticketbox

A small ticket-hold service, built to learn Redis and Postgres properly — what each one is actually for, and where the line between them sits.

Postgres remembers. Redis coordinates.

## What it does

An event has ticket tiers with limited quantities. Click "Get tickets" and those seats are reserved just for you for 120 seconds, with a countdown on screen. Confirm before it hits zero and they're yours. Let it run out and they go back into the pool automatically — for someone else to grab, without anyone lifting a finger.

That reservation window is the entire product. It's also the reason this project needs two databases instead of one: what's _permanent_ (an event happened, an order was placed) lives in Postgres; what's _live and temporary_ (12 seats currently available, this hold dies at 10:02:14) lives in Redis.

No payments, no accounts, no seat maps, no deployment. This is a local, non-deployed learning project.

## Quick start

```bash
git clone <this-repo>
cd ticketbox

./scripts/dev-up.sh         # postgres, redis, redisinsight — one command, waits until all three actually respond
# Windows: .\scripts\dev-up.ps1

pnpm install
pnpm migrate
pnpm seed

pnpm dev:api                # terminal 1 — http://localhost:3000
pnpm dev:worker             # terminal 2 — stream consumer
pnpm dev:web                # terminal 3 — http://localhost:5173
```

`dev-up`'s defaults match `.env.example` exactly, so no `.env` file is required to get started. Copy `.env.example` to `.env` only if you want to change the Postgres credentials.

RedisInsight is available at `http://localhost:5540` for poking at keys directly.

## Architecture

Clean Architecture. Dependencies point inward only — business rules know nothing about Redis, Postgres, or HTTP.

```
Frameworks & Drivers    Fastify · ioredis · pg · React · Docker
  Interface Adapters    Controllers · PgEventRepository · RedisHoldStore
    Use Cases           CreateHold · ConfirmOrder · ReleaseExpiredHolds
      Entities          Event · TicketTier · Hold · Order
```

The practical payoff: `CreateHoldUseCase` never imports `ioredis`. Business rules like "never oversell" are unit-tested in milliseconds with no database running. Swapping Redis clients, or running with Redis switched off entirely, is a small, contained change rather than a rewrite.

Full rationale, the four layers in detail, folder structure, and the Redis/Postgres mechanics behind each design choice: [`docs/01-tech-lead-architecture-and-standards.md`](docs/01-tech-lead-architecture-and-standards.md).

## Tech stack

| Layer        | Choice                                        |
| ------------ | --------------------------------------------- |
| API          | Fastify, TypeScript (strict)                  |
| Truth        | PostgreSQL 16, hand-written SQL               |
| Coordination | Redis 7, `ioredis`, Lua scripts               |
| UI           | React + Vite, no state library                |
| Tests        | Vitest (unit/integration), Playwright (E2E)   |
| Infra        | Docker Compose — local only, nothing deployed |

## Testing

Four levels, distinguished by what's real vs. faked:

| Level       | Real                           | Faked           | Speed          |
| ----------- | ------------------------------ | --------------- | -------------- |
| Unit        | business logic                 | every port      | <2s, no Docker |
| Integration | one adapter + one real engine  | everything else | <30s           |
| Smoke       | the running system             | nothing         | <10s           |
| E2E         | browser → API → both databases | nothing         | minutes        |

```bash
pnpm test:unit
pnpm test:integration   # needs: docker compose up
pnpm test:smoke         # needs: api running
pnpm test:e2e           # needs: full stack
pnpm test:all
```

## Project structure

```
packages/
  api/
    src/
      domain/            entities, value objects — imports nothing
      application/        use cases + ports (interfaces)
      infrastructure/     Redis & Postgres adapters
      presentation/        HTTP controllers, DTOs
      main/                composition root, config
    test/
      unit/ integration/ smoke/ fakes/
  web/
    src/  pages/ components/ api/
    e2e/                   Playwright specs
scripts/lua/               create_hold.lua, release_hold.lua, ...
migrations/
docs/
```

## Documentation

- [`docs/01-tech-lead-architecture-and-standards.md`](docs/01-tech-lead-architecture-and-standards.md) — the business logic, architecture, testing strategy, and code standards, in full
- [`docs/02-product-delivery-plan.md`](docs/02-product-delivery-plan.md) — the build broken into 42 PR-sized tasks across 10 stages
- [`docs/implementation-plans/`](docs/implementation-plans/) — one plan per task, written and approved _before_ coding starts
- [`docs/tasks/`](docs/tasks/) — one write-up per task, written _after_, recording what actually happened
- [`docs/adr/`](docs/adr/) — decision records (why Lua over `WATCH`, why Streams over `SKIP LOCKED`, etc.)
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — measured before/after numbers for every optimization
- [`docs/NOTES.md`](docs/NOTES.md) — write-ups from the deliberate-breakage experiments

[`CLAUDE.md`](CLAUDE.md) holds the working rules for this repo, and [`.claude/agents/`](.claude/agents/) has twelve subagents written for this stack.

## Workflow

Every task runs five phases, in order:

|     | Phase             | Produces                                                                                  |
| --- | ----------------- | ----------------------------------------------------------------------------------------- |
| 1   | **Planning**      | `docs/implementation-plans/TB-NNN-slug.md` — **approved by a human before coding starts** |
| 2   | **Coding**        | the approved plan, implemented                                                            |
| 3   | **Code review**   | correctness, SOLID, DRY, complexity + an anti-slop pass. Findings fixed, then re-reviewed |
| 4   | **Tests**         | the levels the delivery plan demands, each one proven able to fail                        |
| 5   | **Documentation** | `docs/tasks/TB-NNN-slug.md`, plus an ADR if a real decision was made                      |

One task = one branch = one PR = one squash merge.

```
feat/TB-022-lua-create-hold
```

Conventional Commits. CI must be green to merge — typecheck, lint, unit, integration, smoke, E2E, in that order.

## Status

Early build. See [`docs/02-product-delivery-plan.md`](docs/02-product-delivery-plan.md) for the current stage.
