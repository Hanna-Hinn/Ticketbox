# TB-015 — Typed API client

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-015 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-015-typed-api-client.md`](../implementation-plans/TB-015-typed-api-client.md)
**Branch / PR:** `feat/TB-015-typed-api-client` · [#18](https://github.com/Hanna-Hinn/Ticketbox/pull/18) (based on #17)
**ADR:** none.

---

## What this task delivered

The browser has one way to talk to the API. `src/api/client.ts` exposes `listEvents` and `getEvent`, typed with the API's own DTOs (imported type-only from `@ticketbox/api`), and turns every non-2xx into one `ApiError` carrying the envelope's `code` and `message`. The acceptance line — no raw `fetch` outside `api/` — is a lint error, proven on five spellings, not a convention. Nine unit tests cover the client, including the abort path TB-014's review found.

---

## How it works

```
page  ──► useRequest(key, (signal) => api.getEvent(id, signal))
                │
                ▼
src/api/client.ts   createApiClient(fetchFn)        ← tests inject fetchFn; pages use `api`
   request<T>(path, signal)
     fetchFn(path, { signal: signal ?? null })
     !ok  → toApiError(response)                   envelope → ApiError{status, code, message}
                                                   no envelope → ApiError{status, "HTTP_<s>", "no error details"}
                                                   body read aborted → rethrow the AbortError (never an ApiError)
     ok   → response.json() as T                   the API's Zod serializer is the parse; the browser trusts it

types:  import type { EventDto } from "@ticketbox/api/src/presentation/dto/events.js"
        @ticketbox/api is a workspace:* devDependency; verbatimModuleSyntax + lint keep it type-only
        → vite build output contains no "zod" (reviewer checked dist)

lint (packages/web/src/**):
   @ticketbox/api/<anything but src/presentation/dto/>     error
   @ticketbox/api/src/presentation/dto/*                   allowed as `import type` only
   Identifier `fetch` outside src/api/**                   error
   import() / typeof import()                              error (same bypasses TB-009 closed)

tsconfig.json       src/**              browser program, types: ["vite/client"], Node-free (probe → TS2591)
tsconfig.node.json  vite.config.ts
tsconfig.test.json  test/**             sees Node's types through vitest → vite; correct, tests run in Node
```

### Layers touched

| Layer          | What changed                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/api` | None — its DTO modules are read as types                                                                                                               |
| `packages/web` | `src/api/client.ts` new; `api/types.ts` gone; `hooks/useFetch.ts` → `hooks/useRequest.ts`; pages call the client; tests, vitest config, third tsconfig |
| root           | `eslint.config.js`: the `webBoundaries` block                                                                                                          |

### Key files

| File                                        | What it does                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/web/src/api/client.ts`            | The client, `ApiError`, `toApiError`, `isErrorEnvelope`                          |
| `packages/web/src/hooks/useRequest.ts`      | The loading/loaded/error machine over a client call; `${status} ${message}` text |
| `packages/web/test/unit/api/client.test.ts` | Nine behaviours, fetch injected, Node's `Response`                               |
| `eslint.config.js` (`webBoundaries`)        | What web may import from api; the fetch ban; the bypass bans                     |
| `packages/web/tsconfig.test.json`           | The test program                                                                 |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                      | What actually happened                                                                                                                                                                                                                                          | Why                                                                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Decision 3: lint a `CallExpression` whose callee is `fetch`                  | `window.fetch(…)`, `globalThis.fetch(…)` and `const f = fetch; f(…)` all linted clean. The selector is now the identifier `fetch` itself; all four spellings (plus `typeof fetch`) go red.                                                                      | Review, Major. The error message was nudging people to the bypass.                                    |
| Decision 7: no-envelope message `HTTP <status>`                              | The hook already prefixes the status, so the UI read "502 HTTP 502". The message is now "no error details"; the envelope case keeps TB-014's observed "404 event … not found".                                                                                  | Review, Minor — option (b) of two the reviewer offered; (a) would have dropped the prefix everywhere. |
| `export type { EventDto, EventSummaryDto }` "so pages import from one place" | Nothing imported them (pages let `useRequest` infer `T`), and the lint did not make `client.ts` the one place. Deleted; the narrower lint block is deliberately not built until a component needs a DTO type.                                                   | Review, Minor — speculative.                                                                          |
| Decision 5: test program with `types: []`                                    | That line excluded nothing: `vitest/config` → `vite` carries `/// <reference types="node" />`, so the test program sees Node either way (120 `@types/node` files, per the reviewer). Correct for tests; the line was removed so it does not read as an attempt. | Review, note.                                                                                         |
| `fetchFn: typeof fetch = globalThis.fetch`                                   | `(input: string, init?: RequestInit) => Promise<Response>`, defaulting to a wrapper `(input, init) => fetch(input, init)`. Narrower and not relying on WebIDL's unbound-`this` rule.                                                                            | Phase 2; recorded.                                                                                    |
| §5 test table had no row for the signal                                      | Replacing `{ signal: signal ?? null }` with `{}` left every test green while `controller.abort()` would abort nothing. A signal-forwarding test was added; that sabotage now goes red.                                                                          | Review, Major 2 — the test the plan missed.                                                           |
| —                                                                            | Plan decisions 1, 3 and 6 were approved by blanket go-ahead and first challenged at review; 1 and 6 held, 3 did not.                                                                                                                                            | Recorded, not smoothed over.                                                                          |

Named hazards, no code change: `useRequest`'s `load` is deliberately outside the effect's deps (the `key` is the contract); the first caller whose closure captures something other than its key gets stale data, and there is no `react-hooks` lint to catch it — TB-018's checkout page (closure over `token`) is where to look. A 200 with a non-JSON body shows the JSON parser's message, which varies by browser; pinned by a test as deliberate (a proxy answering 200 with HTML is a bug, rule 6). The first non-JSON 2xx endpoint (a 204) will not fit `request<T>`; that task adds the variant, not this one.

---

## 4. Tests shipped

| Level | Test file                                   | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit  | `packages/web/test/unit/api/client.test.ts` | 200 event parsed into the DTO shape, id encoded in the path; 200 list parsed; 404 envelope → `ApiError{404, NOT_FOUND, message}`; non-JSON 502 → `{502, HTTP_502, "no error details"}` (never `statusText`); abort during the body read of a failed response rethrown as the abort; transport failure passed through; **the caller's `AbortSignal` is forwarded, `null` when absent**; 200 with a non-JSON body rejects and not as an `ApiError`; 4xx with non-envelope JSON → `HTTP_422`, no `TypeError` from the narrowing |
| Lint  | trial files, deleted after                  | `fetch(`, `window.fetch(`, `globalThis.fetch(`, aliased `fetch`, `typeof fetch` → red; value import of `EventResponse` → red; `import type` from `api/src/domain` → red; an `application/ports` import inside `src/api/` → red; dynamic `import()` → red; `import type { EventDto }` from the DTO module → green                                                                                                                                                                                                             |

99 api unit · **9 web unit** (0.3 s) · 56 integration · smoke `3 passed | 3 todo` — all observed green on the head.

**Proven able to fail** — five sabotages on `client.ts`, each restored from git, suite green after:

```
S1: `if (!response.ok) throw …` deleted              3 failed  — 404 envelope; non-JSON failure; non-envelope 4xx
S2: message = response.statusText                     2 failed  — non-JSON failure ("never by statusText"); non-envelope 4xx
S3: .catch(() => undefined)  (abort swallowed)        1 failed  — rethrows an abort during the body read
S4: encodeURIComponent(id) → id                       1 failed  — asking for the encoded id
S5: { signal: signal ?? null } → {}                   1 failed  — forwards the caller's AbortSignal   (green before the new test existed — Major 2)
```

**Browser, through the client** (same Playwright flow as TB-014, re-run on this branch): list → click → `["1000 of 1000","200 of 200","Sold out"]` → back/forward with one navigation entry → API stopped → "Could not load: 502 no error details" → Try again → loaded without reload; console errors: the deliberate 502 only.

**Coverage after this task:** `packages/api` unchanged; `packages/web` has no coverage gate yet (TB-042 decides whether web joins the global 80 %).

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It grepped `dist/` for `zod` after `vite build`, listed the files of each of the three `tsc` programs, read ESLint 10's core `no-restricted-imports` source for `regex` + `allowTypeImports`, checked `DOMException instanceof Error` in Node 22, and ran the fetch-spelling trials itself.
**Verdict:** NEEDS WORK → fixed → re-reviewed (trials re-run on the head, 5 spellings red) → **SAFE TO MERGE** once Phase 4 delivered the tests above

| Finding                                                                     | Severity | Resolution                                            |
| --------------------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| The fetch gate matched only a bare call; three bypasses linted clean        | Major    | `Identifier[name="fetch"]`; five spellings proven red |
| `init.signal` never asserted; `{}` left every test green                    | Major    | Signal-forwarding test; S5 goes red                   |
| "502 HTTP 502" — two owners of the status                                   | Minor    | Client message "no error details"; hook prefix kept   |
| Unused DTO type re-export; lint does not make `client.ts` the one place     | Minor    | Deleted; narrower block deliberately not built        |
| `load` outside the effect deps                                              | Minor    | Left; hazard named above and in the follow-ups        |
| 200 + non-JSON body shows the parser's message                              | Minor    | Left; pinned by a test as deliberate                  |
| `types: []` in the test tsconfig excluded nothing                           | Note     | Removed                                               |
| `ApiClient` interface, `{ signal: signal ?? null }`, no `requestNoBody` yet | —        | Confirmed right; no change                            |

Findings deliberately **not** fixed: the two "left" rows.

---

## 6. Failure modes, as built

- **Redis down:** nothing here touches Redis.
- **API down:** `fetchFn` rejects (`TypeError: fetch failed` direct, or the proxy's 502 → `ApiError{502, HTTP_502, "no error details"}`); the page shows the message with Try again; observed.
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** reads only; a stale request's result is dropped by the hook's guard; its `AbortSignal` is now proven to reach `fetch`, so the request itself is cancelled, not merely ignored.
- **Dies halfway through:** a body read that fails rejects into the error state; an aborted one is rethrown as the abort and dropped by the guard (tested at the client level).
- **The DTO changes without the web moving:** `tsc -p tsconfig.json` in `packages/web` fails — the reason to share the type instead of mirroring it.
- **Someone imports a Zod schema into the browser:** lint error; and the bundle would grow by `zod`, which the reviewer's grep of `dist/` would catch.

---

## 7. What I'd do differently

Write the lint trial list before the selector, the way TB-009 learned to. "A bare `fetch` call" was the first spelling I thought of, and the rule's own error message pointed at the second.

---

## 8. Follow-ups left behind

- [ ] **TB-016:** E2E-1 asserts `tier-remaining` exactly, `data-testid` only, zero console errors; make smoke #6 real.
- [ ] **TB-018 (checkout):** the first `useRequest` caller whose closure captures more than its `key` — watch for stale data; consider `eslint-plugin-react-hooks` then (a package; ask).
- [ ] **The first 204 endpoint (`DELETE /holds/:token`, TB-023):** `request<T>` cannot read an empty body; add the no-body variant there.
- [ ] **TB-014's `TODO(tech-debt)` in `format.ts`:** `currency` on `TierResponse` — API-side DTO change, both packages in one PR.
- [ ] **When a component first needs a DTO type:** decide whether only `src/api/**` keeps the DTO import exception and the rest of `src/` goes through `client.ts`.
- [ ] **TB-042:** does `packages/web` join the coverage gate?
