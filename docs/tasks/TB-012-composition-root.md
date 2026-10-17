# TB-012 — Composition root and error mapping

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-012 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-012-composition-root.md`](../implementation-plans/TB-012-composition-root.md)
**Branch / PR:** `feat/TB-012-composition-root` · [#15](https://github.com/Hanna-Hinn/Ticketbox/pull/15) (based on #14)
**ADR:** none.

---

## What this task delivered

The system runs. `pnpm dev:api` boots `main/server.ts`, which loads config, calls `compose()` — the one file that constructs every concrete class, top to bottom — and listens. One Fastify error handler is now the only place an error becomes an HTTP status: `EventNotFound` / `TierNotFound` → 404, Zod validation → 400, Fastify's own client errors keep their 4xx, everything else → 500 with a constant body and a full log line. pino is created once, every request-scoped log line carries the correlation id, and the id goes back to the client in `x-correlation-id`. The pool's `'error'` event is logged instead of ending the process.

---

## How it works

```
main/server.ts        config → compose(config) → listen(0.0.0.0:PORT); SIGINT/SIGTERM → close() (idempotent) → log on failure
main/composition.ts   pino → pool (+ on("error")) → PgEventRepository · UnconfiguredHoldStore · SystemClock
                      → ListUpcomingEvents · GetEventAvailability → EventController → checks { postgres } → buildServer
presentation/http/errors.ts
  Zod validation                      → 400  VALIDATION   (error.message, e.g. "params/id Invalid UUID")
  DomainError in STATUS_OF            → row.status, row.code        EventNotFound · TierNotFound → 404 NOT_FOUND
  Fastify client error (4xx statusCode) → that status, BAD_REQUEST  (bad JSON, unsupported media type, body too large)
  anything else                       → 500  INTERNAL "internal error"   + request.log.error({ err })
  unknown route                       → 404  NOT_FOUND "route not found"
presentation/http/server.ts
  genReqId: client's x-correlation-id if /^[A-Za-z0-9_-]{1,64}$/, else randomUUID()   → reqId on every log line, echoed in the response
  onSend: x-correlation-id, x-response-time (reply.elapsedTime — real now that a logger exists)
```

The status table is keyed on the exact class and carries both the status and the envelope code, so the first non-404 row (TB-025's `HoldExpired` → 409) cannot produce a 409 that says `NOT_FOUND`. The 4xx branch sits _after_ the domain branch so a stray `statusCode` can never reinterpret a `DomainError`.

### Layers touched

| Layer                       | What changed                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 `domain/errors/`         | New: `EventNotFound`, `TierNotFound`                                                                                                       |
| L2                          | None                                                                                                                                       |
| L3 `infrastructure/system/` | New: `SystemClock`, `UnconfiguredHoldStore`                                                                                                |
| L3 `presentation/http/`     | New: `errors.ts`. Changed: `server.ts` (logger, correlation id, `elapsedTime`), `EventController` (throws), `routes/events.ts` (one-liner) |
| L4 `main/`                  | New: `composition.ts`, `server.ts`. Changed: `config.ts` (`LOG_LEVEL`)                                                                     |

### Key files

| File                                             | What it does                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `main/composition.ts`                            | `compose(config): { app, close }` — the map of the system; `close` is memoised          |
| `main/server.ts`                                 | The entry point; signal handling that logs a failed close                               |
| `presentation/http/errors.ts`                    | `STATUS_OF`, `envelope`, `isClientError`, the handler, the not-found handler            |
| `infrastructure/system/UnconfiguredHoldStore.ts` | Empty availability (ADR 0002 fallback), throwing `reserve`/`release`; deleted by TB-022 |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                     | What actually happened                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "anything else → 500"                                                       | **Fastify's own client errors keep their 4xx.** A custom `setErrorHandler` receives the reply with status 200 and must read `error.statusCode` itself; only the default handler applies it. The first draft turned `{not json` (400) and `application/xml` (415) into 500s with an error-level log line. Unreachable with only GET routes — which is why it would have met TB-025's `POST /holds` on day one. | Review, Critical. Verified by the reviewer against Fastify's `error-handler.js`.                                                                                            |
| `STATUS_OF` as an array of `[class, status]` with `NOT_FOUND` in the `send` | A `ReadonlyMap` keyed on the constructor carrying `{ status, code }`; bodies typed as `ErrorDto`.                                                                                                                                                                                                                                                                                                             | Review, Major: the table was the stated extension point and could not take a non-404 row.                                                                                   |
| `requestIdHeader: "x-correlation-id"` + `genReqId: randomUUID`              | `requestIdHeader: false`; the header is read and validated inside `genReqId`. Fastify uses the header _unchecked_ when `requestIdHeader` is set: a 5 kB value became `reqId` on every log line and was echoed back.                                                                                                                                                                                           | Review, Major. A bad id is replaced, not rejected — a courtesy, not a contract.                                                                                             |
| Two `process.once` listeners, `void shutdown()`                             | `close()` is memoised inside `compose()` (so every caller gets idempotence, and it is testable through `inject`), and the signal handler `.catch`es into the logger and sets `exitCode`. SIGINT-then-SIGTERM used to call `pool.end()` twice, which throws, as an unhandled rejection outside pino.                                                                                                           | Review, Major. The memo moved from `server.ts` to `compose()` during Phase 4 because the test could only reach the latter.                                                  |
| Not-found body echoing the request url                                      | `"route not found"`.                                                                                                                                                                                                                                                                                                                                                                                          | Review, Minor: unbounded client input in a body and a log line.                                                                                                             |
| `host` unspecified                                                          | `0.0.0.0`, commented: reachable from outside its container once the compose stage arrives.                                                                                                                                                                                                                                                                                                                    | Review, Minor: an unstated decision.                                                                                                                                        |
| —                                                                           | **Two CI failures on the first pushes**, both legitimate test updates the plan listed but I had not run: `config.test.ts` asserts the exact parsed object and did not know `LOG_LEVEL`; the TB-011 serialization-error test expected Fastify's default body, which the new handler reshapes into the envelope.                                                                                                | I ran typecheck and lint before pushing and not the test suites. Both fixed within minutes; recorded here because the handbook says a push that turns CI red costs a cycle. |
| The "non-404 table row" test the review asked for                           | Not written. `STATUS_OF` is module-private and has no non-404 row yet; exporting it for a test would widen the surface for nothing. TB-025 adds the first 409 row and the test with it.                                                                                                                                                                                                                       | Deliberate.                                                                                                                                                                 |

---

## 4. Tests shipped

| Level       | Test file                                   | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration | `test/integration/http/errors.test.ts`      | thrown `TierNotFound` → 404 envelope; unexpected `Error("boom: secret")` → 500 `INTERNAL`, body has neither `boom`, `secret` nor a stack frame; `InvalidQuantity` → 500, nothing leaked; `application/xml` → 415 and `{not json` → 400, both `BAD_REQUEST`; malformed id → 400 `VALIDATION`; unknown route → 404 with no path echo; correlation id generated on 200/404/500, echoed when well-formed, replaced when 65 chars / whitespace / path-like; **the 500's log line carries `reqId` equal to the response header and the request line carries no headers** (pino into an in-memory stream) |
| Integration | `test/integration/main/composition.test.ts` | `compose()` against the test database: `/health` 200 `{ postgres: "ok" }`; `/events` lists the three seeded events; the real repository reports VIP `remaining: 0`; `close()` twice resolves                                                                                                                                                                                                                                                                                                                                                                                                       |
| Integration | `events.test.ts` (changed)                  | the serialization 500 wears the envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unit        | `test/unit/main/config.test.ts` (changed)   | `LOG_LEVEL` defaults to `info`, accepts `debug`, rejects `loud`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

99 unit · 55 integration (15 new), 4.8 s.

**Proven able to fail** — six sabotages, each reverted, suites green after:

```
SABOTAGE 1: TierNotFound row removed from STATUS_OF        1 failed   (falls to 500)
SABOTAGE 2: 500 path sends String(error)                   2 failed   (message leaks)
SABOTAGE 3: setNotFoundHandler removed                     1 failed   (Fastify's default body)
SABOTAGE 4: 4xx branch disabled                            1 failed   (415/400 become 500)
SABOTAGE 5: requestIdHeader used unchecked                 3 failed   (65-char, whitespace, path-like ids echoed)
SABOTAGE 6: close() not memoised                           1 failed   (pool.end() called twice throws)
```

`grep -rn ".code(4" packages/api/src` outside `errors.ts`: empty (the Acceptance line). `/health`'s `code(503)` is the route's own status, not an error.

**Coverage after this task:** `domain/**` and `application/**` unchanged at 100 % under the unit runner. `main/**` and `presentation/**` are integration-tested only.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It read Fastify's, the type provider's and pino's sources for each behaviour in question and drove `buildServer` in-process with a capturing log sink.
**Verdict:** NEEDS WORK → fixed → re-reviewed (every fix re-probed: 415/400/413 keep their status, the long and malformed ids are replaced, the 64-char one echoed, double close resolves) → **SAFE TO MERGE**

| Finding                                                                                                                                                                                                                                                                                               | Severity | Resolution                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Custom handler never reads `error.statusCode`; Fastify's 4xx errors became 500s                                                                                                                                                                                                                       | Critical | `isClientError` branch after the domain branch                                 |
| Table carried the status but hard-coded `NOT_FOUND`; a 409 row would say `NOT_FOUND`                                                                                                                                                                                                                  | Major    | `ReadonlyMap<class, { status, code }>`; `envelope()`; `ErrorDto`               |
| `requestIdHeader` trusts any client value unbounded into every log line and the response                                                                                                                                                                                                              | Major    | Validated in `genReqId`; header option off                                     |
| Shutdown could run twice; a failed close was an unhandled rejection                                                                                                                                                                                                                                   | Major    | Memoised close in `compose()`; `.catch` into the logger                        |
| Not-found body echoed the url                                                                                                                                                                                                                                                                         | Minor    | Constant message                                                               |
| `host: "0.0.0.0"` undecided in the plan                                                                                                                                                                                                                                                               | Minor    | Commented; plan decision 11                                                    |
| Two comments elsewhere still refer to this handler in the future tense                                                                                                                                                                                                                                | Minor    | `dto/errors.ts` fixed (in scope); `DomainError.ts` left — not this task's file |
| Checked, no finding: Zod validation covers params/body/query/headers; serialization errors land on the 500 path; the 500 body is constant; pino request lines carry `reqId` and no headers; `reply.elapsedTime` is real under a silent logger; `UnconfiguredHoldStore`'s empty map must not be logged | —        | —                                                                              |

Findings deliberately **not** fixed: the `DomainError.ts` comment tense (outside this task's file list).

---

## 6. Failure modes, as built

- **Redis down:** nothing here talks to Redis; `UnconfiguredHoldStore` never does.
- **Postgres down, in-flight query:** 500 with the envelope and a logged error with the request id. **Idle client drops:** logged through `pool.on("error")`, process stays up (tested by the reviewer's reading of pg-pool, not by a test — would need a killable connection).
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** `close()` twice resolves (tested). `compose()` twice is two systems; fine.
- **Dies halfway through:** a throw inside `compose` is a boot failure before `listen`. A request mid-flight gets the error handler. `app.close()` has no deadline under Fastify's default `forceCloseConnections: "idle"`; the only in-flight work today is a health check bounded at 2 s.
- **A client sends a hostile correlation id:** replaced by a UUID; the hostile value reaches neither the log nor the response (tested).

---

## 7. What I'd do differently

Run both test suites before every push, not only typecheck and lint. The two CI reds were seconds of work to fix and cost a cycle each; the handbook's "one validated push beats three speculative ones" was written for exactly this. And read how a framework's _custom_ hook differs from its _default_ before replacing the default — the 4xx-to-500 bug was in the first ten lines of Fastify's error handler.

---

## 8. Follow-ups left behind

- [ ] TB-017: the `redis` closure for `/health`.
- [x] TB-022: delete `UnconfiguredHoldStore`; wire `RedisHoldStore`.
- [ ] TB-025: the first non-404 row in `STATUS_OF`, with the test that its envelope code comes from the row.
- [ ] `app.close()` has no deadline; when long-lived connections exist (SSE, TB-037), `forceCloseConnections` or a timeout becomes a decision.
- [ ] `domain/errors/DomainError.ts` comment says "TB-012's single error handler" in the future tense; fix when that file is next touched.
