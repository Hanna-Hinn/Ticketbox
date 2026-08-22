# Ticketbox — Engineering Handbook

**Author role:** Tech Lead
**Audience:** the engineer building this (you)
**Companion document:** `02-product-delivery-plan.md` — what to build, in what order, as PRs

**How claims are labelled.** "I know [N]" = comes from a documented source, listed at the end. "I think" = my own reasoning, no source — disagree freely.

---

# Part 1 — What are we actually building?

## 1.1 The one-sentence version

**Ticketbox is a tiny box office. It sells tickets to events, and it holds your tickets for two minutes while you check out.**

That's it. That's the whole product.

## 1.2 The business problem, in plain English

Imagine a concert with **100 tickets**. **500 people** want them, and they all click at 10:00:00.

Here's the awkward bit. When someone clicks "Get 2 tickets", you can't sell them yet — the person still has to type their email, pick a payment method, and confirm. That takes maybe 90 seconds. But you also can't just let all 500 people start checking out for the same 100 tickets, because then 500 people will complete checkout and you've sold 500 tickets for a 100-seat room. That's called **overselling**, and in the real world it means angry people at a door and refunds.

So real ticketing systems do this:

> You click "Get 2 tickets" → **those 2 tickets are reserved just for you, for 120 seconds** → a countdown timer appears → you either finish checkout (the tickets become yours permanently) or the timer hits zero (the tickets go back into the pool for someone else).

That temporary reservation is called a **hold**. You have seen this exact countdown on Ticketmaster, Eventbrite, and every airline seat picker. That is the entire business logic of this project.

## 1.3 Walk through it as a user

1. Hanna opens Ticketbox and sees a list of events.
2. She clicks "Rooftop Jazz Night". She sees three ticket types: **General €20 (847 left)**, **Balcony €35 (12 left)**, **VIP €80 (sold out)**.
3. She picks 2× Balcony and clicks **Get tickets**.
4. The number drops to **10 left** — immediately, for everyone looking at the page, not just for her.
5. A timer appears: **01:59… 01:58…**
6. She types her email and clicks **Confirm**. She gets an order number. The 2 balcony seats are now permanently hers.
7. Meanwhile, another user did steps 3–5 but went to make coffee. His timer hit zero. His 2 tickets went back to the pool and the counter went **10 → 12** on its own.

## 1.4 Why this needs two databases

This is the actual point of the project, so read this bit twice.

Look at the data in that story. It splits cleanly into two kinds:

**Kind A — what happened. Permanent, must never be lost.**
The event exists. The venue has 100 seats. Hanna bought 2 balcony tickets for €70 at 10:04pm. If this data is lost, the business is destroyed. It must survive a server catching fire. It needs constraints, relationships, audit trails, and refunds six months later.

→ **This is Postgres.** A relational database is exactly this: durable, transactional, queryable truth.

**Kind B — what is happening right now. Fast, temporary, self-cleaning.**
12 balcony tickets are currently available. Hanna is holding 2 of them and her hold dies at 10:02:14. 400 people are watching this page and each needs the live count. Someone abandoned their cart 3 seconds ago and the count must go back up.

This data is read hundreds of times a second, changes constantly, expires on its own schedule, and — critically — **if you lost all of it, you could rebuild it from Kind A.** It's derived state.

→ **This is Redis.** An in-memory data-structure server, with built-in expiry and genuinely atomic operations.

I think this is the single clearest way to understand what Redis is for: **Postgres remembers, Redis coordinates.** Every stage of this project is a variation on that sentence.

## 1.5 Glossary — learn these five words

| Term             | Meaning in Ticketbox                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| **Event**        | A thing you can buy tickets for. "Rooftop Jazz Night".                                            |
| **Ticket tier**  | A category of ticket within an event, with its own price and quantity. "Balcony, €35, 100 total". |
| **Hold**         | A temporary reservation of N tickets from one tier, expiring in 120 seconds. The core concept.    |
| **Order**        | A hold that got confirmed before its timer ran out. Permanent.                                    |
| **Availability** | `total − sold − currently held`. The number the user sees. Changes constantly.                    |

## 1.6 What we are deliberately NOT building

No payments. No login or user accounts. No seat maps or seat selection (just quantities). No emails. No deployment, no cloud, no Terraform. No admin UI beyond two debug endpoints. No Redis Cluster or Sentinel.

I think scope discipline matters more here than anywhere, because every one of those is a plausible-sounding rabbit hole that teaches you nothing about the thing you came to learn.

---

# Part 2 — Architecture

## 2.1 Clean Architecture, and why

We're using Clean Architecture. I know [1] its central idea is **the Dependency Rule: source code dependencies point only inwards, and nothing in an inner circle may know anything about an outer circle.** I know [1] the layers are Entities, Use Cases, Interface Adapters, and Frameworks & Drivers, and that the outermost layer is where the details live — I know [1] the original framing is blunt about this: the web is a detail, the database is a detail, and we keep them on the outside where they can do little harm.

I think that framing is worth taking literally in this project, because it produces a very specific and very useful outcome: **your business rules will not import Redis or Postgres.** Which means:

- You can unit-test "never oversell" in milliseconds with no Docker running.
- You can swap `ioredis` for `node-redis` by changing one file (a stretch goal — and a real proof the boundary held).
- Stage 10's "run with Redis switched off" experiment takes ten minutes instead of a day.
- When you're deep in a Lua script, you can still see clearly which part is _business rule_ and which part is _Redis technique_.

I know [1] that Clean Architecture doesn't mandate exactly four circles — the Dependency Rule is the part that always applies. We'll use four.

## 2.2 The four layers

```
┌──────────────────────────────────────────────────────────────┐
│ 4. FRAMEWORKS & DRIVERS         (the details)                │
│    Fastify · ioredis · pg · React · Docker · Playwright      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 3. INTERFACE ADAPTERS       (translators)              │  │
│  │    HTTP controllers · DTO mappers · PgEventRepository  │  │
│  │    RedisHoldStore · StreamPublisher · React components │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │ 2. USE CASES            (application rules)      │  │  │
│  │  │    CreateHoldUseCase · ConfirmOrderUseCase       │  │  │
│  │  │    ReleaseExpiredHoldsUseCase                    │  │  │
│  │  │    …and the PORTS they depend on (interfaces)    │  │  │
│  │  │  ┌────────────────────────────────────────────┐  │  │  │
│  │  │  │ 1. ENTITIES         (business rules)       │  │  │  │
│  │  │  │    Event · TicketTier · Hold · Order       │  │  │  │
│  │  │  │    Money · Quantity                        │  │  │  │
│  │  │  └────────────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
              dependencies point INWARD only  ←──
```

**Layer 1 — Entities.** Plain TypeScript objects with behaviour and no imports from anywhere else in the codebase. `Hold.isExpired(now)`. `TicketTier.canFulfil(qty)`. `Money.add()`. These rules would be true even if Ticketbox were run on paper.

**Layer 2 — Use Cases.** One class per user goal, one public method: `execute(input): Promise<Output>`. `CreateHoldUseCase` knows the _sequence_ — validate quantity, ask the hold store to atomically reserve, mirror to the repository, publish an event — but has no idea any of those are Redis or Postgres. It talks only to **ports**: interfaces it defines itself.

**Layer 3 — Interface Adapters.** Translators, both directions. `HoldController` turns an HTTP request into a use-case input and a use-case output into an HTTP response. `RedisHoldStore` implements the `HoldStore` port using Lua scripts. `PgEventRepository` implements `EventRepository` using SQL.

**Layer 4 — Frameworks & Drivers.** Fastify itself, the `ioredis` client object, the `pg` Pool, React, Docker. Almost no code of ours lives here — just wiring.

## 2.3 The Dependency Rule made concrete

The awkward question: `CreateHoldUseCase` needs to talk to Redis, but Redis is in an outer layer. How does an inner layer use an outer one without depending on it?

**Answer: the inner layer defines the interface; the outer layer implements it.** This is Dependency Inversion, and it's the mechanical trick that makes the whole thing work.

```ts
// LAYER 2 — src/application/ports/HoldStore.ts
// The use case says what it NEEDS. No mention of Redis anywhere.
export interface HoldStore {
  reserve(
    tierId: TierId,
    qty: number,
    token: HoldToken,
    ttlMs: number,
  ): Promise<
    { ok: true; remaining: number } | { ok: false; reason: "insufficient" }
  >;
  release(token: HoldToken): Promise<{ released: boolean }>;
  availability(eventId: EventId): Promise<Map<TierId, number>>;
}

// LAYER 3 — src/infrastructure/redis/RedisHoldStore.ts
// The adapter says HOW. It depends inward on the interface. The interface
// knows nothing about it.
export class RedisHoldStore implements HoldStore {
  /* Lua scripts here */
}

// LAYER 2 — src/application/use-cases/CreateHoldUseCase.ts
export class CreateHoldUseCase {
  constructor(
    private readonly holds: HoldStore, // ← interface, not class
    private readonly tiers: TicketTierRepository,
    private readonly clock: Clock,
    private readonly tokens: TokenGenerator,
  ) {}
  async execute(input: CreateHoldInput): Promise<CreateHoldOutput> {
    /* … */
  }
}

// LAYER 4 — src/main/composition.ts
// The ONLY file allowed to `new` an adapter. This is where the arrow flips.
const holdStore: HoldStore = new RedisHoldStore(redis, keys);
const createHold = new CreateHoldUseCase(
  holdStore,
  tiers,
  systemClock,
  uuidTokens,
);
```

The three ports that make testing pleasant, and which I think people forget:

- **`Clock`** — never call `Date.now()` inside a use case. Inject it. Then a unit test can say "it is now 10:02:15" and assert the hold expired, with no `setTimeout` and no flakiness. For a project whose core concept is a timer, this is not optional.
- **`TokenGenerator`** — inject UUID generation so tests get predictable tokens.
- **`EventPublisher`** — so the use case can announce "hold created" without knowing whether that's Pub/Sub, a Stream, or nothing at all.

## 2.4 Folder structure

```
ticketbox/
├── docker-compose.yml
├── migrations/                       001_events.sql … 006_outbox.sql
├── packages/
│   ├── api/
│   │   ├── src/
│   │   │   ├── domain/                        ← LAYER 1. Imports NOTHING.
│   │   │   │   ├── entities/                  Event.ts Hold.ts Order.ts TicketTier.ts
│   │   │   │   ├── value-objects/             Money.ts Quantity.ts HoldToken.ts
│   │   │   │   └── errors/                    DomainError.ts InsufficientInventory.ts
│   │   │   ├── application/                   ← LAYER 2. Imports domain only.
│   │   │   │   ├── ports/                     HoldStore.ts EventRepository.ts
│   │   │   │   │                              OrderRepository.ts Clock.ts
│   │   │   │   │                              EventPublisher.ts RateLimiter.ts Lock.ts
│   │   │   │   └── use-cases/                 CreateHold.ts ReleaseHold.ts
│   │   │   │                                  ConfirmOrder.ts GetEventAvailability.ts
│   │   │   │                                  ReleaseExpiredHolds.ts
│   │   │   ├── infrastructure/                ← LAYER 3. Implements ports.
│   │   │   │   ├── postgres/                  pool.ts PgEventRepository.ts
│   │   │   │   │                              PgOrderRepository.ts PgHoldMirror.ts
│   │   │   │   ├── redis/                     client.ts keys.ts scripts.ts
│   │   │   │   │                              RedisHoldStore.ts CachedEventRepository.ts
│   │   │   │   │                              RedisLock.ts RedisRateLimiter.ts
│   │   │   │   │                              StreamPublisher.ts PubSubPublisher.ts
│   │   │   │   └── system/                    SystemClock.ts UuidTokenGenerator.ts
│   │   │   ├── presentation/                  ← LAYER 3. HTTP side.
│   │   │   │   ├── http/                      server.ts routes/ controllers/
│   │   │   │   ├── dto/                       request+response schemas (Zod)
│   │   │   │   └── mappers/                   domain ↔ DTO
│   │   │   ├── worker/                        ← LAYER 4 entry point
│   │   │   └── main/                          ← LAYER 4. composition.ts config.ts
│   │   └── test/
│   │       ├── unit/  integration/  smoke/  concurrency/
│   │       └── fakes/                         InMemoryHoldStore.ts FakeClock.ts …
│   └── web/                                   ← React UI (Vite)
│       ├── src/  pages/ components/ api/ hooks/
│       └── e2e/                               Playwright specs
├── scripts/lua/                               create_hold.lua release_hold.lua
│                                              sweep_holds.lua rate_limit.lua unlock.lua
└── docs/                                      BENCHMARKS.md NOTES.md ADRs
```

## 2.5 One request, traced through every layer

`POST /holds { eventId, tierId, qty: 2 }` — worth reading once slowly:

1. **L4** Fastify receives the HTTP request.
2. **L3** `preHandler` hook → `RedisRateLimiter` (implements the `RateLimiter` port) says this IP is under its limit.
3. **L3** `HoldController` validates the body with a Zod DTO and maps it to `CreateHoldInput` — a plain object, no HTTP types.
4. **L2** `CreateHoldUseCase.execute()` runs: asks `Clock` for now, asks `TokenGenerator` for a token, calls `holdStore.reserve(...)`.
5. **L3** `RedisHoldStore` runs `create_hold.lua` via `EVALSHA`, atomically decrementing availability and writing a hold key with a 120s TTL.
6. **L1** The returned data is used to construct a `Hold` entity, which enforces its own invariants (qty ≥ 1, expiry after creation).
7. **L2** The use case mirrors the hold via `HoldRepository` and calls `publisher.holdCreated(...)`.
8. **L3** `HoldController` maps the output DTO; `PubSubPublisher` fans the new count out to SSE subscribers.
9. **L4** Fastify serialises `201 Created`.

Note what the use case (step 4) knows: nothing about Lua, TTLs, SQL, or HTTP status codes. That's the whole point.

---

# Part 3 — The UI

## 3.1 Yes, and it earns its place

**Yes, the project should have a UI**, and I think it makes the project meaningfully better rather than just prettier, for three reasons:

1. **It makes Redis visible.** A countdown timer ticking down and a number that jumps back up on its own is what "TTL as business logic" _looks like_. Watching it in a browser lands differently from reading a passing integration test.
2. **It's the only honest way to demo the live-availability feature.** Two browser tabs updating simultaneously from a Pub/Sub message is the demo. There isn't a text-based equivalent.
3. **It gives you a real E2E layer.** Without a UI, your "E2E" tests are just API tests wearing a hat.

## 3.2 Deliberately thin

The UI must stay dumb, or it becomes the project. Rules:

- **Vite + React + TypeScript.** No Next.js — SSR adds concepts unrelated to what we're learning.
- **No state management library.** `useState` and `useEffect` only. There are three screens.
- **No component library.** Plain CSS, one stylesheet. It should look tidy, not designed.
- **Zero business logic.** The browser never computes availability, never decides if a hold is expired. It renders what the API says. If you catch yourself writing `if (remaining < qty)` in React, that rule belongs in an entity.
- **The countdown is display-only.** It counts down from the server-provided `expiresAt`. When it reaches zero the UI re-fetches; it does _not_ assume the hold is dead. The server is the authority on time.

## 3.3 Three screens

| Screen           | Route              | Shows                                                                | Talks to                                                                    |
| ---------------- | ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Event list**   | `/`                | Cards for upcoming events                                            | `GET /events`                                                               |
| **Event detail** | `/events/:id`      | Tiers, prices, **live availability**, quantity picker, "Get tickets" | `GET /events/:id`, SSE `GET /events/:id/availability/stream`, `POST /holds` |
| **Checkout**     | `/checkout/:token` | Countdown timer, order summary, email field, Confirm                 | `GET /holds/:token`, `POST /orders`, `DELETE /holds/:token`                 |

Plus a tiny `/debug` page showing cache hit ratio, stream depth, and DLQ length — genuinely useful while you work, and about 30 lines.

---

# Part 4 — Testing strategy

You asked for four levels. The trap is that these words mean different things at different companies, so here are the definitions **we** are using. The distinguishing question is: _what is real, and what is faked?_

## 4.1 The four levels

### Unit tests — everything faked, nothing real

**Scope:** Layers 1 and 2 only — entities, value objects, use cases.
**What's real:** your business logic.
**What's faked:** every port. `InMemoryHoldStore`, `FakeClock`, `FakeEventRepository`.
**Infrastructure needed:** none. No Docker. No network.
**Speed:** the whole suite under 2 seconds.
**Tool:** Vitest.

This is where Clean Architecture pays for itself. "A hold cannot be created for more tickets than remain" is a business rule and it gets tested without a database existing.

```ts
it("expires exactly at its expiry instant, not before", () => {
  const clock = new FakeClock("2026-01-01T10:00:00Z");
  const hold = Hold.create({
    tierId,
    qty: 2,
    now: clock.now(),
    ttlMs: 120_000,
  });
  clock.advance(119_999);
  expect(hold.isExpired(clock.now())).toBe(false);
  clock.advance(1);
  expect(hold.isExpired(clock.now())).toBe(true);
});
```

No `setTimeout`, no flake, sub-millisecond. That's what the `Clock` port bought you.

**Target: ~60% of all tests.**

### Integration tests — one adapter, one real dependency

**Scope:** Layer 3 adapters, in isolation.
**What's real:** a real Postgres, or a real Redis. Nothing else.
**What's faked:** everything on the other side. No HTTP server, no UI, no worker.
**Infrastructure:** `docker compose up`. Redis DB index 9, `FLUSHDB` in `beforeEach`. A dedicated Postgres database, each test in a transaction that rolls back.
**Speed:** whole suite under 30 seconds.
**Tool:** Vitest with a separate config and setup file.

This is where you verify things unit tests structurally cannot: that your SQL is valid, that your Lua script actually decrements, that a TTL actually expires the key.

**Every Lua script must have an integration test. Non-negotiable** — a Lua bug is invisible to TypeScript.

**Concurrency tests are a named sub-category here** and they're the most valuable tests in the project. `Promise.all` of 200 simultaneous reserve calls against a tier with 10 remaining, asserting the exact final count and exactly 10 successes. I think most engineers never write one of these, and it's the test that catches the entire class of bug this project is about.

**Target: ~30% of all tests.**

### Smoke tests — is it alive?

**Scope:** the running system, from outside, checking it came up correctly.
**What's real:** everything.
**Faked:** nothing.
**Purpose:** answer "did this start up in a usable state?" in under 10 seconds. Run after `docker compose up`, and in CI before the E2E suite.
**Tool:** a plain Vitest file hitting the running API over HTTP.

Deliberately tiny — around six assertions, no more:

1. `GET /health` returns 200 with both Postgres and Redis green.
2. `GET /events` returns a non-empty array (seed data loaded).
3. `GET /events/:id` returns 200 for a seeded ID.
4. `POST /holds` for 1 ticket returns 201 (the write path works end to end).
5. `DELETE /holds/:token` returns 200 (cleanup works).
6. The web app's root HTML is served.

If smoke fails, don't bother running E2E — something is fundamentally broken and E2E failures will be noise.

**Target: ~6 tests total, forever.**

### End-to-end tests — a human, in a browser

**Scope:** browser → React → API → Postgres + Redis → worker → back.
**What's real:** all of it, including the UI and timing.
**Tool:** Playwright against the compose stack.
**Speed:** minutes. That's acceptable, which is exactly why there are few of them.

Five journeys, and I think five is the right number — enough to cover the product, few enough to stay green:

| #     | Journey                                                                                     | Proves                                              |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| E2E-1 | Browse events → open one → see tiers and availability                                       | Read path, UI wiring                                |
| E2E-2 | Get tickets → countdown appears → confirm → order number shown                              | The happy path, the whole product                   |
| E2E-3 | Get tickets → wait for the timer to expire → availability returns to its original number    | TTL + sweeper + reconciliation, the hardest feature |
| E2E-4 | Two browser contexts; one holds tickets, the **other tab's number drops without reloading** | Pub/Sub + SSE                                       |
| E2E-5 | Double-click Confirm rapidly → exactly one order exists                                     | Idempotency                                         |

**Target: 5 specs.**

## 4.2 The shape

```
        ╱╲          5 E2E              minutes   ← few, slow, highest confidence
       ╱  ╲         6 smoke            seconds
      ╱────╲        ~40 integration    <30s
     ╱      ╲       ~90 unit           <2s      ← many, fast, run constantly
    ╱────────╲
```

I think the ratio matters more than the absolute numbers. If you find yourself with 40 E2E tests, something has gone wrong — a rule that could have been tested in a unit test has leaked into the UI layer.

## 4.3 Rules that apply to all levels

- **Naming:** `describe('CreateHoldUseCase')` → `it('rejects a hold larger than remaining inventory')`. The `it` reads as a sentence about behaviour, never about implementation. Not `it('calls holdStore.reserve')`.
- **AAA structure**, with blank lines between Arrange / Act / Assert.
- **No shared mutable state between tests.** Every test builds its own world.
- **No sleeping.** `await new Promise(r => setTimeout(r, 3000))` is banned in unit and integration tests — use `FakeClock`, or a deliberately tiny real TTL (50ms) with polling in the specific tests that must exercise real Redis expiry.
- **Test data via builders:** `aTier().withRemaining(10).build()`. Prevents 40 lines of setup per test.
- **A test must be able to fail.** Before trusting a new test, break the implementation and watch it go red. Especially the concurrency ones.
- **Bug fixes start with a failing test** that reproduces the bug. Always.

## 4.4 Commands

```
pnpm test:unit          # no docker needed, run on every save
pnpm test:integration   # needs compose up
pnpm test:smoke         # needs the API running
pnpm test:e2e           # needs the full stack
pnpm test:all           # everything, in that order
```

---

# Part 5 — Code quality rules

**TypeScript**

- `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`.
- `any` is banned. `unknown` plus narrowing instead. `as` casts require a comment explaining why.
- No non-null assertions (`!`). If you know it's non-null, prove it to the compiler.
- Branded types for IDs: `type EventId = string & { readonly __brand: 'EventId' }`. Prevents passing a tier ID where an event ID belongs — a bug this domain is unusually prone to.

**Boundaries (enforced, not aspirational)**

- ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`) with these rules, which will fail CI if broken:
  - `domain/**` may import from `domain/**` only.
  - `application/**` may import `domain/**` and `application/**`. **Never** `ioredis`, `pg`, `fastify`.
  - `infrastructure/**` and `presentation/**` may import inward, never from each other.
  - Only `main/composition.ts` may import concrete adapter classes.

**Lint & format**

- ESLint + `@typescript-eslint` + Prettier. `--max-warnings 0`.
- Husky + lint-staged pre-commit: format, lint, typecheck, `test:unit`.

**Commits & PRs**

- Conventional Commits: `feat(holds): add Lua-backed reserve`.
- One PR per task in the delivery plan. Squash merge. Branch `feat/TB-022-lua-create-hold`.
- PR description states: what, why, which tests were added, and which task ID it closes.
- **CI must be green to merge.** No exceptions.

**CI pipeline (GitHub Actions, on every PR)**
`typecheck → lint → test:unit → build → docker compose up → migrate + seed → test:integration → test:smoke → test:e2e`

**Coverage gates**

- `domain/**` and `application/**`: **90% lines**. These are pure and there's no excuse.
- `infrastructure/**`: 70%.
- Global: 80%. CI fails below.
- Coverage is a floor, not a goal. A 100%-covered use case with no concurrency test is not tested.

**Logging & errors**

- Structured logging (`pino`). `console.log` banned by lint.
- Every request gets a correlation ID, propagated into worker messages.
- Domain errors are typed classes extending `DomainError`. Mapped to HTTP **once**, in a single Fastify error handler — never `reply.code(409)` scattered through controllers.
- Never log an idempotency key, email, or full request body at info level.

---

# Part 6 — Code design rules

1. **The Dependency Rule is absolute** [1]. If you need an exception, you've found a missing port.
2. **Ports are named for what the domain needs, not the technology.** `HoldStore`, not `RedisClient`. `EventPublisher`, not `PubSub`. If the port name contains a vendor, the abstraction has leaked.
3. **One use case, one public method**, called `execute`. If a use case needs two, it's two use cases.
4. **Constructor injection only.** No service locator, no DI container, no singletons reached across module boundaries. The composition root wires everything explicitly — it's the map of the system, and it should be readable top to bottom.
5. **Entities are immutable.** Mutations return new instances. Concurrency bugs are the subject of this project; shared mutable state is not the way to study them.
6. **Expected failures are return values; bugs are exceptions.** "Not enough tickets" is an expected outcome — return `{ ok: false, reason: 'insufficient' }`. "The database connection died" is an exception. Don't use exceptions for control flow.
7. **Controllers contain no business logic.** They validate, map, call one use case, map back. If a controller has an `if` about the domain, move it.
8. **Only simple data crosses boundaries.** DTOs in and out, never Fastify's `Request` object, never a `pg` row, never an `ioredis` reply. This mirrors [1]'s advice that only simple structures should cross a boundary.
9. **All Redis keys come from the key registry.** A string literal key anywhere else is a review rejection.
10. **Every Lua script is a named module with a typed wrapper and an integration test.** Never inline Lua in a method body.
11. **Comment the why, never the what.** Every Lua script gets a header comment explaining the race condition it prevents. That's the highest-value comment in the codebase.
12. **Write an ADR** (`docs/adr/NNN-title.md`, ~1 page) for each real decision: why Lua over `WATCH`, why cache-aside over write-through, why Streams over `SKIP LOCKED`. I think these are the most valuable artefacts you'll produce, because in six months they're what you'll actually reread.

---

# Part 7 — Technical reference

Condensed engine mechanics you'll need. Verify against the sources as you go.

## 7.1 Redis

**Commands are serialised.** Each command is atomic; **a sequence of commands from your app is not** — a network round-trip sits between them and another client can slot in. This is the bug Stage 5 of the delivery plan makes you produce on purpose.

**Combining commands:**

| Mechanism         | Atomic?    | Branch on a value mid-way?      | Use when                                  |
| ----------------- | ---------- | ------------------------------- | ----------------------------------------- |
| Pipelining        | No         | No                              | Fewer round-trips only                    |
| `MULTI`/`EXEC`    | Yes        | No — queued, replies at the end | Fixed batch                               |
| `WATCH` + `MULTI` | Optimistic | In app code, with retries       | Rare; retry-heavy                         |
| **Lua**           | **Yes**    | **Yes**                         | Read → decide → write must be indivisible |

I know [4][5] Lua scripts run atomically and block all other server activity for their duration — the blocking _is_ the guarantee. I know [4] Redis will not auto-kill an over-running script, because that would leave a half-applied dataset; it replies `BUSY` to other clients and accepts only `SCRIPT KILL` or `SHUTDOWN NOSAVE`. I know [4] `SCRIPT KILL` only works if the script hasn't written yet. I know [15] the threshold is `busy-reply-threshold`, default 5000ms. **So: keep scripts short and loop-free.** I know [5] `EVALSHA` sends a SHA-1 instead of the body; `ioredis`'s `defineCommand` handles the `NOSCRIPT` fallback.

**Expiry.** I know [2][3] keys expire two ways: **passively**, when a client touches an expired key, and **actively**, via a background cycle. I know [2] the active cycle runs 10×/second and is probabilistic — sample 20 keys that have a TTL, delete the expired ones, and repeat immediately if more than 25% of the sample was expired.

Three consequences:

- An expired key can occupy memory past its TTL until sampled or touched. TTL guarantees _visibility_, not the instant of freeing.
- Expiry is not a reliably observable event.
- I know [2] a TTL is **cleared** by value-_replacing_ commands (`DEL`, `SET`, `GETSET`, `*STORE`) but **left untouched** by in-place modifications (`INCR`, `LPUSH`, `HSET`). So `SET k v EX 60` then `INCR k` keeps the original deadline; but a plain `SET k v` refresh silently makes the key immortal. A real and common bug.

I know [2] expiry times are absolute Unix timestamps, so time passes while Redis is down and clock skew between machines can expire keys on load.

**Eviction ≠ expiry.** I know [6] expiry is time-driven while eviction is memory-pressure-driven at `maxmemory`, with policies `noeviction`, `allkeys-lru|lfu|random`, `volatile-lru|lfu|random|ttl` — `volatile-*` considering only keys that have a TTL. **The trap:** under `allkeys-lru`, Redis can evict a key you rely on for correctness — a lock, a hold, an inventory counter. I know [6] the docs note `volatile-*` exists for exactly this mixed use case, but that running two separate instances is usually the better answer.

**Streams.** I know [10] a stream is an append-only log; producers `XADD`, consumers read via `XREADGROUP` in a group. I know [10] the **group** holds one `last-delivered-id` cursor while **each consumer** has its own **Pending Entries List (PEL)** — delivered but unacknowledged messages. I know [7] the special ID `>` means "never delivered to anyone", and delivery is recorded in the PEL until `XACK`. I know [9] `XACK` removes the entry, and until then the server assumes the message may be unprocessed, so re-reading with ID `0` returns your own unacked history. I know [8] a dead consumer's entries just sit in the PEL, inspectable with `XPENDING` and reclaimable with `XCLAIM`, or automatically with `XAUTOCLAIM`. I know [7] `NOACK` skips the PEL entirely — opting into acceptable message loss.

**That machinery is the entire difference between Streams and Pub/Sub.** Pub/Sub has none of it.

## 7.2 Postgres

**MVCC.** An `UPDATE` writes a new tuple version rather than overwriting, so readers never block writers. Two consequences: dead tuples accumulate (hence `VACUUM` and table bloat), and `SELECT COUNT(*)` must actually count, because visibility is per-transaction. That second one is an honest reason to keep counters in Redis.

**Isolation.** I know [13] Postgres accepts all four standard levels but implements three — Read Uncommitted behaves as Read Committed, since that's the only sensible MVCC mapping. I know [13] Repeatable Read sees only data committed before the transaction began and never concurrent commits during it, and that Postgres's implementation is stronger than the standard requires because it forbids phantom reads too. Read Committed (the default) snapshots **per statement**; Repeatable Read **per transaction**.

**Row locking.** I know [12] `SELECT … FOR UPDATE` locks returned rows as though for update, blocking other transactions from modifying, deleting, or locking them until the current transaction ends. I know [11] `NOWAIT` errors instead of waiting and `SKIP LOCKED` skips rows that can't be locked immediately. I know [11] the docs are explicit that skipping locked rows gives an **inconsistent view of the data** and is unsuitable for general-purpose work — but is right for avoiding contention among multiple consumers of a queue-like table. I know [11] both options affect only row-level locks; the table-level `ROW SHARE` lock is still taken normally.

I know [14] Postgres also has **advisory locks** — application-defined, unrelated to any row — the direct analogue of a Redis distributed lock.

## 7.3 "Could Postgres already do this?"

Ask this every time. I think being able to argue both sides is the real deliverable.

| You want         | Redis answer                | Postgres answer               | My view                                                                                                  |
| ---------------- | --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Job queue        | Streams + consumer groups   | `FOR UPDATE SKIP LOCKED` [11] | Postgres wins until throughput is genuinely high — one datastore, transactional, crash-safe free         |
| Distributed lock | `SET NX PX` + Lua release   | Advisory locks [14]           | Advisory locks release on disconnect, killing a bug class. Redis wins on latency and cross-service reach |
| Idempotency      | `SET NX` + stored response  | `UNIQUE` constraint           | Use both: constraint for truth, Redis for the fast path                                                  |
| Rate limiting    | ZSET or token bucket in Lua | Awkward, write-heavy          | Redis, clearly                                                                                           |
| Live fanout      | Pub/Sub                     | `LISTEN`/`NOTIFY`             | Close at small scale; `NOTIFY` is transactional, a real advantage                                        |
| Hot counters     | `INCR`                      | `COUNT(*)` must scan          | Redis, clearly                                                                                           |

---

## Sources

- [1] Web: Robert C. Martin — The Clean Architecture — https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- [2] Web: Redis documentation (community mirror) — EXPIRE — https://redis-doc-test.readthedocs.io/en/latest/commands/expire/
- [3] Web: Redis FAQ — impacts of the expiration algorithm — https://redis.io/faq/doc/1fqjridk8w/what-are-the-impacts-of-the-redis-expiration-algorithm
- [4] Web: Redis documentation (community mirror) — EVAL / scripting — https://redis-doc-test.readthedocs.io/en/latest/commands/eval/
- [5] Web: Redis Docs — Redis functions and programmability — https://redis.io/docs/latest/develop/programmability/functions-intro/
- [6] Web: Redis Docs — Key eviction — https://redis.io/docs/latest/develop/reference/eviction/
- [7] Web: Redis Docs — XREADGROUP — https://redis.io/docs/latest/commands/xreadgroup/
- [8] Web: Redis Docs — XCLAIM — https://redis.io/docs/latest/commands/xclaim/
- [9] Web: Redis Docs — XACK — https://redis.io/docs/latest/commands/xack/
- [10] Web: Redis Docs — Redis streaming with node-redis — https://redis.io/docs/latest/develop/use-cases/streaming/nodejs/
- [11] Web: PostgreSQL Documentation — SELECT (locking clauses) — https://www.postgresql.org/docs/current/sql-select.html
- [12] Web: PostgreSQL Documentation — 13.3 Explicit Locking — https://www.postgresql.org/docs/current/explicit-locking.html
- [13] Web: PostgreSQL Documentation — 13.2 Transaction Isolation — https://www.postgresql.org/docs/current/transaction-iso.html
- [14] Web: PostgreSQL Documentation — Chapter 13 Concurrency Control (incl. 13.3.5 Advisory Locks) — https://www.postgresql.org/docs/18/mvcc.html
- [15] Web: Redisson glossary — Redis Lua scripting (`busy-reply-threshold`) — https://redisson.pro/glossary/redis-lua-scripting.html

Everything without a bracketed number is my own reasoning, marked "I think" — including all architecture, layering, testing-ratio, standards, and UI decisions.
