# TB-012 — Composition root and error mapping

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-012 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-012-composition-root` (stacked on `feat/TB-011-http-layer`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `main/composition.ts` wiring every concrete class. A single Fastify error handler mapping `DomainError` subclasses to status codes. `pino` structured logging with a correlation ID per request.

**Acceptance:** `composition.ts` reads top to bottom as a map of the system. No `reply.code(4xx)` anywhere outside the error handler.

**Tests:** **integration** — a thrown `TierNotFound` yields 404 with a consistent error envelope; an unexpected error yields 500 and does _not_ leak a stack trace to the client.

**Depends on:** TB-011 (open, PR #14 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

The system becomes runnable: one file constructs every concrete thing in dependency order and hands the result to the server, a second file is the process entry point, and `pnpm dev:api` works for the first time. Alongside it, the three loose ends TB-010 and TB-011 handed over are tied: the one `reply.code(404)` in a route moves into a single error handler keyed on `DomainError` subclasses, the pool gets its `'error'` listener, and the hand-rolled response timer goes because the logger now exists.

One thing the Scope line cannot know: `GetEventAvailabilityUseCase` needs a `HoldStore`, and the real one is TB-022. §3 decision 4 answers it.

---

## 3. Approach

### Layers touched

| Layer                       | What changes                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| L1 `domain/errors/`         | New: `EventNotFound.ts`, `TierNotFound.ts` (the two the handler maps today)                                                    |
| L2                          | None                                                                                                                           |
| L3 `infrastructure/system/` | New: `SystemClock.ts`, `UnconfiguredHoldStore.ts` (decision 4)                                                                 |
| L3 `presentation/http/`     | New: `errors.ts` (the handler + not-found handler). Changed: `server.ts`, `controllers/EventController.ts`, `routes/events.ts` |
| L4 `main/`                  | New: `composition.ts`, `server.ts`. Changed: `config.ts` gains `LOG_LEVEL`                                                     |

### The composition root, top to bottom

```ts
export function compose(config: Config): { app: FastifyInstance; close(): Promise<void> };
const log = pino({ level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL);
pool.on("error", (err) => log.error({ err }, "idle postgres client errored"));
const events = new PgEventRepository(pool); // EventRepository
const holds = new UnconfiguredHoldStore(); // HoldStore — until TB-022
const clock = new SystemClock(); // Clock
const listUpcoming = new ListUpcomingEventsUseCase(events, clock);
const getAvailability = new GetEventAvailabilityUseCase(events, holds);
const controller = new EventController(listUpcoming, getAvailability);
const checks = { postgres: () => pool.query("SELECT 1").then(() => undefined) }; // redis: TB-017
const app = buildServer({ logger: log, events: controller, checks });
return {
  app,
  close: async () => {
    await app.close();
    await pool.end();
  },
};
```

Nothing else in the repo may `new` an adapter; the TB-009 lint already enforces that for `main/**`.

### The error handler

```
presentation/http/errors.ts — registerErrorHandling(app)
  setErrorHandler:
    Zod validation error (hasZodFastifySchemaValidationErrors)  → 400  { error: { code: "VALIDATION",  message } }
    EventNotFound | TierNotFound                                 → 404  { error: { code: "NOT_FOUND",   message } }
    any other DomainError  (an invariant violation = a bug)      → 500  { error: { code: "INTERNAL",    message: "internal error" } }  + log.error
    anything else                                                → 500  same, + log.error
  setNotFoundHandler:                                            → 404  { error: { code: "NOT_FOUND",   message: "route … not found" } }
```

Nothing about the thrown error reaches the client on a 500: not the message, not the stack, not the class. The log line has all of it, with the request id.

### Decisions this plan is making

1. **The controller throws `EventNotFound`; the route is a one-liner.** TB-011 decision 10 recorded this shape: `get()` no longer collapses the use case's `{ ok: false, reason }` into `null`, it translates the one reason into the one typed error the handler maps. The 404 schema on the route stays (the serializer validates the envelope).
2. **`EventNotFound` and `TierNotFound` live in `domain/errors/`** and extend `DomainError`, as the Scope line's "mapping `DomainError` subclasses" and the Tests line's "a thrown `TierNotFound`" both assume. `TierNotFound` has no thrower until the hold route exists (TB-022/025); it is added now because the Tests line names it and the test throws it from a throwaway route. Both carry the id in the message.
3. **Status mapping is an explicit table in the handler, not a property on the error.** A `status` field on a domain error would be HTTP knowledge in Layer 1. The table is the "once" in "mapped to HTTP once".
4. **`UnconfiguredHoldStore` is the `HoldStore` until TB-022.** `availability()` returns an empty map, so every read falls back to the computed count (ADR 0002 — this is the "store has never seen the tier" case, exactly); `reserve()` and `release()` throw, because no route calls them yet and a silent no-op reservation would be a lie. It lives in `infrastructure/system/` (the handbook's folder for `SystemClock` and `UuidTokenGenerator`), is three methods long, and is deleted by TB-022. An honest null object beats making the use case's dependency optional.
5. **pino is created in the composition root and handed to Fastify as `loggerInstance`.** Fastify's own logger _is_ pino, but creating it ourselves means the pool's `'error'` listener and boot/shutdown lines use the same logger with the same level, and `buildServer` stays ignorant of configuration. `pino` becomes an explicit dependency at the version Fastify already bundles. `LOG_LEVEL` joins `config.ts` (default `info`); tests pass `pino({ level: "silent" })`.
6. **Correlation ID = Fastify's request id**, generated with `randomUUID()` unless the client sends `x-correlation-id`, and echoed back in the same header. pino's request-scoped logger already carries `reqId`, so every log line in a request has it for free. `x-response-time` becomes `reply.elapsedTime` — the `WeakMap` and its `TODO(tech-debt)` go.
7. **`main/server.ts` is the process entry point** (`pnpm dev:api` → `tsx watch src/main/server.ts`): load `config`, `compose`, `listen`, and close on `SIGTERM`/`SIGINT`. Eleven lines; the composition root is importable without listening, which is what the integration test needs.
8. **Fastify's own 4xx errors keep their status** _(added after the Phase 3 review — Critical)_. A custom `setErrorHandler` receives the reply with status 200 and must read `error.statusCode` itself; only Fastify's _default_ handler applies it. The first draft turned a malformed JSON body (400) and an unsupported media type (415) into 500s with an error-level log line — unreachable today with only GET routes, which is exactly why TB-025's `POST /holds` would have met it on day one. The 4xx branch sits _after_ the domain branch so a stray `statusCode` can never reinterpret a `DomainError`.
9. **The status table carries the envelope code and is keyed on the exact class** _(review — Major)_. The first draft hard-coded `NOT_FOUND` in the `send`, so the first non-404 row (TB-025's `HoldExpired` → 409) would have produced a 409 saying `NOT_FOUND`. The handler's bodies are typed as `ErrorDto`, the same schema the routes declare.
10. **A client-supplied correlation id is validated** (`/^[A-Za-z0-9_-]{1,64}$/`) _(review — Major)_. Fastify's `requestIdHeader` uses the header unchecked, so a 5 kB value became `reqId` on every log line and was echoed back. The header is read inside `genReqId` instead; a bad value is silently replaced, not rejected — a correlation id is a courtesy, not a contract.
11. **Shutdown is memoised and a failed close is logged** _(review — Major)_. Two `process.once` listeners meant SIGINT-then-SIGTERM called `pool.end()` twice (which throws), and `void shutdown()` turned that into an unhandled rejection outside pino. `app.close()` has no deadline under Fastify's default `forceCloseConnections: "idle"`; the only in-flight work today is a health check bounded at 2 s, so that is a known property, not a bug. `host: "0.0.0.0"` is a stated decision now: the API must be reachable from outside its container.
12. **No `reply.code(4xx)` outside `errors.ts`.** The Acceptance line, checked by grep in the task doc. `/health`'s `reply.code(healthy ? 200 : 503)` is a 5xx and is the route's own status, not an error; it stays.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File                                                                               | New / Changed                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/api/src/domain/errors/EventNotFound.ts`, `TierNotFound.ts`               | New                                                   |
| `packages/api/src/infrastructure/system/SystemClock.ts`                            | New                                                   |
| `packages/api/src/infrastructure/system/UnconfiguredHoldStore.ts`                  | New                                                   |
| `packages/api/src/presentation/http/errors.ts`                                     | New                                                   |
| `packages/api/src/presentation/http/server.ts`                                     | Changed                                               |
| `packages/api/src/presentation/http/controllers/EventController.ts`                | Changed                                               |
| `packages/api/src/presentation/http/routes/events.ts`                              | Changed                                               |
| `packages/api/src/main/composition.ts`, `main/server.ts`                           | New                                                   |
| `packages/api/src/main/config.ts`                                                  | Changed                                               |
| `packages/api/test/unit/main/config.test.ts`                                       | Changed                                               |
| `packages/api/test/integration/http/errors.test.ts`                                | New                                                   |
| `packages/api/test/integration/main/composition.test.ts`                           | New                                                   |
| `packages/api/test/integration/http/{events,health}.test.ts`                       | Changed (logger dep; the 404/400 envelope assertions) |
| `packages/api/package.json`, root `package.json`, `pnpm-lock.yaml`, `.env.example` | Changed                                               |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                        | What it would catch                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Integration | a throwaway route throwing `TierNotFound` → 404 `{ error: { code: "NOT_FOUND", message } }`                                                                                 | the Tests line, literally                           |
| Integration | a throwaway route throwing `new Error("boom: secret")` → 500 `{ error: { code: "INTERNAL", message: "internal error" } }`, body contains neither `boom`, `secret` nor `at ` | a leaked message or stack                           |
| Integration | a throwaway route throwing an `InvalidQuantity` (a `DomainError` not in the table) → 500, nothing leaked                                                                    | a domain invariant surfacing as a 4xx               |
| Integration | malformed `:id` → 400 with the envelope and `code: "VALIDATION"`                                                                                                            | the type provider's default body surviving          |
| Integration | unknown route → 404 with the envelope                                                                                                                                       | Fastify's default not-found body surviving          |
| Integration | `GET /events/:id` unknown → 404 envelope (unchanged assertion, now via `EventNotFound`)                                                                                     | the controller still returning `null`               |
| Integration | `x-correlation-id` generated when absent, echoed when supplied                                                                                                              | the id not reaching the response                    |
| Integration | `compose(config)` against the test database: `/health` 200 with `postgres: "ok"`, `/events` 200                                                                             | a wiring mistake in the composition root            |
| Unit        | `config.test.ts`: `LOG_LEVEL` defaults to `info`, rejects `loud`                                                                                                            | a bad level crashing at boot with a cryptic message |

**Concurrency:** N/A.

**How each test will be proven able to fail:** map `TierNotFound` to 500 (the 404 test goes red); send `error.message` on the 500 path (the leak test goes red); drop `setNotFoundHandler` (the unknown-route test goes red); drop the correlation header echo (that test goes red); wire `UnconfiguredHoldStore` where the repository belongs (the compose test goes red).

---

## 6. Risks and failure modes

- **What if Redis is down?** Nothing here talks to Redis. `UnconfiguredHoldStore` never does either.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** `compose` twice is two pools and two servers — fine in tests, never done in production; `close()` releases both.
- **What if it dies halfway through?** `compose` is synchronous construction; a throw there is a boot failure with a stack trace on stderr, before `listen`. Mid-request: the error handler.
- **What if Postgres is down?** Boot does not probe it (the pool connects lazily); `/health` says `postgres: "down"`; an event route gets a 500 with the envelope and a log line. **An idle client dropping its connection** now logs through `pool.on("error")` instead of killing the process (TB-010's finding).

---

## 7. Could Postgres already do this?

N/A — no Redis capability. `UnconfiguredHoldStore` is the honest statement that, until TB-022, Postgres _is_ doing all of it.

---

## 8. Open questions

None blocking. Decision 4 (a null-object `HoldStore` in `infrastructure/system/`) is the one a reviewer may want done differently; the alternatives — an optional dependency in the use case, or wiring a test fake from `main/` — are each worse in a way the TB-009 lint or rule 3 already names.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed; the status table and the null object are not Redis/Postgres decisions
- ☑ Task doc — `docs/tasks/TB-012-composition-root.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
