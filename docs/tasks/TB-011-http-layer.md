# TB-011 — HTTP layer and controller

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-011 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-011-http-layer.md`](../implementation-plans/TB-011-http-layer.md)
**Branch / PR:** `feat/TB-011-http-layer` · [#14](https://github.com/Hanna-Hinn/Ticketbox/pull/14) (based on #13)
**ADR:** none.

---

## What this task delivered

Something to call. `buildServer(deps)` returns a Fastify instance with three routes — `GET /events`, `GET /events/:id`, `GET /health` — whose request and response shapes are Zod schemas, so a malformed `:id` is a 400 from the framework before any handler runs and a handler returning the wrong shape is a 500 rather than a lie on the wire. `EventController` maps strings in and DTOs out with no Fastify type on either side. Every response carries `x-response-time`. A third use case, `ListUpcomingEventsUseCase`, exists because the list route needed one.

---

## How it works

```
buildServer({ events, checks, healthCheckTimeoutMs? })
  fastify-type-provider-zod      validator + serializer: the DTOs are the route schemas
  onRequest / onSend             x-response-time from a WeakMap<request, hrtime>   ← temporary, see §3
  GET /events        → controller.list()      → EventSummary[]
  GET /events/:id    → controller.get(id)     → EventDto | null → 200 | 404 { error: { code, message } }
  GET /health        → every check raced against a 2 s deadline, independently → 200 ok | 503 degraded

EventController(listUpcoming, getAvailability)
  list(): EventSummaryDto[]        get(id: string): EventDto | null
```

The controller holds no `if` about the domain: the one ternary maps the use case's `ok` discriminator, and "an unknown event is a failure" was decided in `GetEventAvailabilityUseCase`. What `null` means over HTTP is the route's business, and that one `reply.code(404)` moves into TB-012's single error handler.

`/health` takes closures (`Record<string, () => Promise<void>>`) written by the composition root with the drivers it already holds — a `Record` rather than `{ postgres, redis }` because the Redis closure only exists from TB-017. Each is raced against a deadline: `Promise.all` only reports engines "independently" if every ping _settles_, and the realistic dead-engine failure is a socket that never answers.

### Layers touched

| Layer                       | What changed                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1                          | None                                                                                                                                                 |
| L2 `application/use-cases/` | New: `ListUpcomingEvents.ts`                                                                                                                         |
| L3 `presentation/`          | New: `http/server.ts`, `http/routes/{events,health}.ts`, `http/controllers/EventController.ts`, `dto/{events,health,errors}.ts`, `mappers/events.ts` |
| L4                          | None — `main/composition.ts` is TB-012                                                                                                               |

### Key files

| File                                               | What it does                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `presentation/http/server.ts`                      | `buildServer`; the two timing hooks with a `TODO(tech-debt)` tied to TB-012                           |
| `presentation/http/routes/health.ts`               | `DependencyChecks`, `pingWithin`, `DEFAULT_CHECK_TIMEOUT_MS = 2000`                                   |
| `presentation/http/routes/events.ts`               | The two event routes; the one `reply.code(404)` until TB-012                                          |
| `presentation/http/controllers/EventController.ts` | Map in, one use case, map out                                                                         |
| `presentation/dto/*.ts`                            | `EventIdParams` (`z.uuid()`), `EventResponse`, `EventListResponse`, `HealthResponse`, `ErrorResponse` |
| `presentation/mappers/events.ts`                   | Use-case output → DTO (`Date` → ISO string)                                                           |
| `application/use-cases/ListUpcomingEvents.ts`      | Summaries only, instant from `Clock`                                                                  |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                               | What actually happened                                                                                                                                                                                                                                                                                                                       | Why                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/health` pings with `Promise.all` and reports separately             | **Each ping is raced against a deadline** (default 2 s). Without it a hung socket hung the whole route and hid the healthy engine — the exact case the file's own comment claimed could not happen.                                                                                                                                          | Review, Critical. The sabotage that removes the race makes the test time out at 10 s.                           |
| Timer via a module `Symbol`, `decorateRequest`, a module augmentation | A `WeakMap` closed over in `buildServer`. Five moving parts for one number, all of which exist only because `logger: false` means Fastify never records `reply.elapsedTime`. When TB-012 turns pino on the pair collapses to one line; marked `TODO(tech-debt)`.                                                                             | Review, Major.                                                                                                  |
| `ErrorResponse` in `dto/events.ts`                                    | `dto/errors.ts` — it is cross-cutting.                                                                                                                                                                                                                                                                                                       | Review, Minor.                                                                                                  |
| No configurability                                                    | `ServerDeps.healthCheckTimeoutMs?` — only a test has a reason to set it. A 50 ms real bound beats a 2 s wait in a test, the same reasoning the handbook gives for a tiny real TTL.                                                                                                                                                           | Phase 4 needed it to prove the Critical fix without sleeping.                                                   |
| Decision 3: controller returns `DTO \| null`, route maps `null` → 404 | Unchanged here, but recorded as something TB-012 must redo rather than inherit: `get()` discards `reason`, and with a second failure reason the ternary becomes the controller deciding two domain outcomes are one HTTP outcome. TB-012's shape: the controller throws `EventNotFound` (does not exist yet) and the single handler maps it. | Review, Major — plan decision 10. The 404 test asserts status and envelope only, so TB-012 does not rewrite it. |
| —                                                                     | The first unit test for `ListUpcomingEvents` was rejected by `Event.create`: the tier builder defaults to the seeded event id, and the event under test had another. The TB-006 invariant doing its job against its author.                                                                                                                  | Test bug, fixed with `aTier().forEvent(…)`.                                                                     |

---

## 4. Tests shipped

| Level       | Test file                                                                       | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `test/unit/application/use-cases/ListUpcomingEvents.test.ts`                    | only events after the injected clock; summaries carry no tiers                                                                                                                                                                                                                                                                                                                                                                             |
| Integration | `test/integration/http/events.test.ts` (real `PgEventRepository`, `app.inject`) | 200 body shape (tiers, `priceCents`, ISO `startsAt`); 404 envelope for a well-formed unknown id; **400 for a malformed id with the use case never called** (spy); uppercase id → 200, nil uuid → 404; a store reporting `−1` → 500 `FST_ERR_RESPONSE_SERIALIZATION` with no `-1` in the body; `GET /events` summaries without `tiers`; `[]` when the clock is past every event; `x-response-time` on 200, 404 envelope, 400, unknown route |
| Integration | `test/integration/http/health.test.ts`                                          | all ok → 200; one down → 503 with both reported; **a ping that never settles → 503 with the other engine still `ok`**, within a 50 ms bound                                                                                                                                                                                                                                                                                                |

97 unit (1.1 s) · 40 integration (3.0 s), of which 14 are this task's HTTP tests.

**Proven able to fail** — five sabotages, each reverted, suites green after:

```
SABOTAGE 1: params schema z.uuid() → z.string()           1 failed  (malformed id reaches the use case)
SABOTAGE 2: 404 branch returns 200 {}                     2 failed
SABOTAGE 3: onSend hook removed                           4 failed  (header missing on every path)
SABOTAGE 4: Promise.race removed from pingWithin          1 failed  (× … 10004ms — the route hung until vitest's timeout)
SABOTAGE 5: /health reports {} unless everything is ok    2 failed
```

**Coverage after this task:** `domain/**` and `application/**` remain at 100 % under the unit runner (the new use case included). `presentation/**` is integration-tested only, like `infrastructure/**`.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool; it read the installed Fastify, type-provider and Zod sources and probed the server, including a hung ping.
**Verdict:** NEEDS WORK → fixed → re-reviewed (the reviewer re-ran its hung-ping probe: 503 after 2031 ms with `postgres: "ok"`, no dangling timer) → **SAFE TO MERGE**

| Finding                                                                                               | Severity | Resolution                                                                      |
| ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `/health` hangs on a ping that never settles, hiding the healthy engine                               | Critical | `pingWithin` racing a deadline; `clearTimeout` in `finally`                     |
| `get()` collapses the use case's reason to `null`; TB-012 would inherit a route `if` it cannot remove | Major    | Recorded for TB-012 (plan decision 10); 404 test asserts status + envelope only |
| Symbol + `decorateRequest` + module augmentation for one number, all because `logger: false`          | Major    | `WeakMap`; `TODO(tech-debt)` naming `reply.elapsedTime` and TB-012              |
| `ErrorResponse` in a resource-named file                                                              | Minor    | `dto/errors.ts`                                                                 |
| 400 and unknown-route bodies are Fastify's defaults until TB-012                                      | Minor    | Tests assert status only for those                                              |
| `z.uuid()` admits uppercase and the nil UUID                                                          | Minor    | Pinned by a test so a stricter schema later is a deliberate change              |
| Two `withTypeProvider` calls; `dto/health.ts` as its own file                                         | Minor    | Left — the alternatives cost more than the duplication                          |

Findings deliberately **not** fixed: the last row.

---

## 6. Failure modes, as built

- **Redis down:** `/health` reports `redis: "down"` (TB-017 supplies the closure). Nothing else here touches Redis.
- **Postgres down:** `/health` reports it; `GET /events*` reject through the use case to Fastify's default 500 — right status, wrong envelope until TB-012. An engine that _hangs_ rather than refuses: `/health` still answers within the bound (tested); the event routes would hang until the driver's own timeout, which TB-012's pool configuration should bound.
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** all reads.
- **Dies halfway through:** nothing is written.
- **A handler returns a shape its schema rejects:** 500 `FST_ERR_RESPONSE_SERIALIZATION`, generic body, no Zod detail leaks (tested with a negative `remaining`). The mapper is the only thing between a use case and that 500.

---

## 7. What I'd do differently

Treat "independently" as a claim about _time_, not just about _errors_. I wrote `Promise.all` and a comment saying one failure could not hide another, and it was true for a thrown error and false for the failure that actually happens.

---

## 8. Follow-ups left behind

- [ ] **TB-012:** controller throws `EventNotFound extends DomainError`; the single error handler maps it; the route's `if` and `reply.code(404)` go; the 400 and unknown-route bodies get the envelope; `reply.elapsedTime` replaces the `WeakMap` timer once pino is on; `pool.on("error")` (from TB-010).
- [ ] TB-012 / TB-017: write the `postgres` and `redis` closures for `/health`.
- [ ] TB-039: decide whether a degraded Redis is a 503 or a 200 `degraded`.
