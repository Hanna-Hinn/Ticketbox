# TB-011 — HTTP layer and controller

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-011 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-011-http-layer` (stacked on `feat/TB-010-pg-event-repository`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** Fastify server. `presentation/dto` Zod request/response schemas. `EventController` mapping DTO ↔ use case. Routes `GET /events`, `GET /events/:id`, `GET /health` (checking both engines independently). `x-response-time` header.

**Acceptance:** the controller contains no `if` about domain rules. A malformed UUID returns 400 from schema validation, not from a thrown error deeper in.

**Tests:** **integration** — 200 with the expected body shape; 404 for unknown ID; 400 for a malformed ID; `/health` reports each dependency separately.

**Depends on:** TB-010 (open, PR #13 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

The HTTP half of Layer 3: a Fastify server built by a function that takes its dependencies, three routes, Zod schemas for what goes in and out, and a controller that is nothing but mapping. No composition root yet (TB-012 wires real adapters and the error handler); this task's integration tests build the server with the real `PgEventRepository` on one side and the in-memory fakes on the other, which is exactly the "one adapter, one real engine" shape the handbook wants.

Two things the Scope line implies but does not say: `GET /events` needs a use case that does not exist yet (TB-008 built two, neither lists events), and `/health` must report two engines when the Redis client does not exist until TB-017. §3 handles both.

---

## 3. Approach

### Layers touched

| Layer                       | What changes                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1                          | None                                                                                                                                                                  |
| L2 `application/use-cases/` | New: `ListUpcomingEvents.ts` (decision 1)                                                                                                                             |
| L3 `presentation/`          | New: `http/server.ts`, `http/routes/events.ts`, `http/routes/health.ts`, `http/controllers/EventController.ts`, `dto/events.ts`, `dto/health.ts`, `mappers/events.ts` |
| L4                          | None — `main/composition.ts` is TB-012                                                                                                                                |

### The shape

```
buildServer({ events: EventController, checks: DependencyChecks }) → FastifyInstance
  validator/serializer: fastify-type-provider-zod       ← Zod schemas are the route schemas; a bad :id is a 400 before any handler runs
  onRequest: note hrtime · onSend: x-response-time: <ms>
  GET /events       → controller.list()                 → EventSummary[]        200
  GET /events/:id   → controller.get(id)                → EventResponse        200 | 404 { error: { code, message } }
  GET /health       → each check pinged independently   → { status, checks }   200 ok | 503 degraded

EventController(listUpcoming, getAvailability)          no Fastify type in or out; plain strings in, DTOs out
  list(): Promise<EventSummaryDto[]>
  get(id: string): Promise<EventDto | null>             null = the use case said unknown-event
```

### Decisions this plan is making

1. **A third use case, `ListUpcomingEventsUseCase(events, clock)`.** "Controllers call one use case" and `GET /events` has none to call. It returns summaries (`id`, `name`, `venue`, `startsAt`) — the list page shows cards, not tiers — and takes `Clock` because `listUpcoming(now)` needs an instant and a use case must not read the system clock. This is a plan addition beyond TB-008's two use cases and is listed in §4; unit-tested like the others.
2. **`fastify-type-provider-zod` is added**, so the Zod schemas _are_ Fastify's route schemas and a malformed `:id` is rejected by the framework with a 400 before the handler runs — the literal Acceptance line. The alternative (parse inside the handler and `reply.code(400)`) puts the 400 in the controller, which TB-012 then has to pull out again. Registry at planning time: `fastify@5.12.7`, `fastify-type-provider-zod@7.0.0` (peers: `fastify ^5.5`, `zod ≥4.1.5` — the repo has `zod ^4.4.3`; its `@fastify/swagger` / `openapi-types` peers are for OpenAPI generation, which is not used).
3. **The controller takes strings and returns DTOs or `null`; the route turns `null` into a 404.** No `FastifyRequest` crosses into the controller (rule 8), and the one `if` in the route (`dto === null → 404`) is HTTP mapping, not a domain rule. TB-012 will fold that mapping into its single error handler; until then `reply.code(404)` lives in the route, and the task doc will say so.
4. **`/health` takes `DependencyChecks = Record<string, () => Promise<void>>`**, pings every entry independently, and reports `{ status: "ok" | "degraded", checks: { postgres: "ok", redis: "down" } }` — 200 when all pass, 503 otherwise. The composition root writes the closures (TB-012 for Postgres, TB-017 for Redis) with the drivers it already holds; no port, no interface for infrastructure to implement, nothing for `infrastructure/` to import from `presentation/` (which the TB-009 lint forbids). Whether a degraded Redis should be a 503 is TB-039's question; the shape lets it change the code without changing the contract.
5. **`priceCents` in the response, not a formatted price.** The UI formats; the API states integers. `startsAt` is an ISO-8601 string. No `soldOut` flag: `remaining: 0` says it, and a derived boolean is the kind of domain rule that would otherwise end up in the controller.
6. **`buildServer` creates Fastify with `logger: false`.** Logging, the correlation ID and the error handler are TB-012's Scope line, verbatim. Adding a logger option now would be configurability nobody asked for yet.
7. **Error envelope for the 404 is `{ error: { code: "NOT_FOUND", message } }`.** TB-012 owns "a consistent error envelope"; this is the shape it will keep. The 400 from schema validation carries the type provider's own body (`statusCode`, `code`, `error`, `message`); reshaping it is TB-012's job too.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File                                                                      | New / Changed |
| ------------------------------------------------------------------------- | ------------- |
| `packages/api/src/application/use-cases/ListUpcomingEvents.ts`            | New           |
| `packages/api/src/presentation/dto/events.ts`                             | New           |
| `packages/api/src/presentation/dto/health.ts`                             | New           |
| `packages/api/src/presentation/mappers/events.ts`                         | New           |
| `packages/api/src/presentation/http/controllers/EventController.ts`       | New           |
| `packages/api/src/presentation/http/routes/events.ts`                     | New           |
| `packages/api/src/presentation/http/routes/health.ts`                     | New           |
| `packages/api/src/presentation/http/server.ts`                            | New           |
| `packages/api/test/unit/application/use-cases/ListUpcomingEvents.test.ts` | New           |
| `packages/api/test/integration/http/events.test.ts`                       | New           |
| `packages/api/test/integration/http/health.test.ts`                       | New           |
| `packages/api/package.json`, `pnpm-lock.yaml`                             | Changed       |

---

## 5. Test plan

| Level       | Test                                                                                                 | What it would catch                                |
| ----------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unit        | `ListUpcomingEvents` passes the injected clock's instant and maps to summaries                       | `Date.now()`; tiers leaking into the list          |
| Integration | `GET /events/:id` → 200, body shape (ids, `priceCents`, `remaining`, ISO `startsAt`)                 | mapper wrong; serializer rejecting a `Date`        |
| Integration | `GET /events/:id` unknown well-formed id → 404 with the envelope                                     | a 500, or an empty 200                             |
| Integration | `GET /events/:id` malformed id → 400, **and the use case was never called**                          | the Acceptance line; validation happening too late |
| Integration | `GET /events` → 200 with summaries, no `tiers` key                                                   | the list leaking tiers                             |
| Integration | `x-response-time` present on every response                                                          | the hook pair                                      |
| Integration | `/health` with both checks passing → 200 `{ status: "ok", checks: { postgres: "ok", redis: "ok" } }` | —                                                  |
| Integration | `/health` with Redis failing → 503, `postgres: "ok"`, `redis: "down"` — reported separately          | one failure hiding the other's status              |

The HTTP tests use `app.inject` (no port, no network) with the real `PgEventRepository` on the test database and the TB-008 fakes for everything else.

**Concurrency:** N/A.

**How each test will be proven able to fail:** remove `z.uuid()` from the params schema (400 test goes red); return `[]` from the 404 branch (404 test goes red); drop the `onSend` hook (header test goes red); make `/health` stop at the first failure (the "reported separately" test goes red).

---

## 6. Risks and failure modes

- **What if Redis is down?** `/health` says so, per dependency. Nothing else here touches Redis yet.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** All three routes are reads; idempotent.
- **What if it dies halfway through?** A request in flight fails; nothing is written.
- **What if Postgres is down?** The route's use case rejects; with no error handler yet (TB-012), Fastify's default returns a 500 with its default body. Correct status, wrong envelope — TB-012.

---

## 7. Could Postgres already do this?

N/A — no Redis capability.

---

## 8. Open questions

None blocking. Decision 3 (a `reply.code(404)` in the route until TB-012) is the one a reviewer might want pre-empted; doing TB-012's error handler here would widen this PR into the next task.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-011-http-layer.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
