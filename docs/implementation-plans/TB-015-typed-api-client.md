# TB-015 — Typed API client

**Status:** Implemented — see [`docs/tasks/TB-015-typed-api-client.md`](../tasks/TB-015-typed-api-client.md) §3 for where reality diverged
**Date:** 2026-10-17
**Task:** TB-015 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-015-typed-api-client` (stacked on `feat/TB-014-vite-react-app`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Why:** the UI shouldn't hand-roll `fetch` in every component.

**Scope:** `web/src/api/client.ts` with typed functions per endpoint, sharing the response DTO types with the API package. Central error handling.

**Acceptance:** no raw `fetch` call outside `api/`.

**Tests:** **unit** — client parses a success response; surfaces a 404 as a typed error.

**Depends on:** TB-014 (open, PR #17, the base of this branch) — confirmed: ☑

---

## 2. What I understand this to mean

TB-014 left one `fetch` in `hooks/useFetch.ts` and two hand-copied interfaces in `api/types.ts`, both marked for this task. TB-015 makes `src/api/client.ts` the only place the browser talks HTTP: one function per endpoint (`listEvents`, `getEvent`), returning the API's own DTO types imported from `packages/api`, and one place that turns a non-2xx into a typed `ApiError` carrying the envelope's `code` and `message`. The acceptance line is a lint rule, not a convention.

"Sharing the response DTO types" means types, not schemas. The browser does not run Zod on responses; the API's serializer already guarantees the shape on its side, and a runtime import of the DTO module would put `zod` in the bundle and make `@ticketbox/api` a runtime dependency of the web app. Type-only, enforced by lint (decision 2).

---

## 3. Approach

### Layers touched

| Layer          | What changes                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/api` | None. The DTO module is imported as types only; no export map, no file moves                                              |
| `packages/web` | New `src/api/client.ts`; `api/types.ts` deleted; `hooks/useFetch.ts` becomes `hooks/useRequest.ts`; pages call the client |
| root           | `eslint.config.js`: a `packages/web` block (decision 2 and 3); `test:unit` already fans out via `-r --if-present`         |

### The client

```ts
// src/api/client.ts — the only file in packages/web that may call fetch
export class ApiError extends Error { status: number; code: string }     // code: envelope code, or "HTTP_<status>" when there is no envelope

export function createApiClient(fetchFn: FetchFn = (input, init) => fetch(input, init)): ApiClient   // (review) narrower than `typeof fetch`, wrapped rather than an unbound reference
  listEvents(signal?): Promise<EventSummaryDto[]>        GET /api/events
  getEvent(id, signal?): Promise<EventDto>              GET /api/events/:id   (404 → throws ApiError{status: 404, code: "NOT_FOUND"})

export const api = createApiClient();                    // what the pages use
```

`request<T>(path, signal)` is the one private function: `fetchFn` → `!ok` → read the envelope if there is one → throw `ApiError`; else `json()` as `T` (commented cast; the parse stays server-side). An `AbortError` from `fetchFn` or from the body read is rethrown untouched: the hook's guard is what decides what an abort means, and swallowing it was TB-014's Major 2.

`useRequest(key, load)` replaces `useFetch(url)`: same loading/loaded/error state machine and the same `settle` guard; `load(signal)` is a closure over the client call, `key` is the string the effect re-runs on (the event id, or `""` for the list). The error message comes from `ApiError` as `${status} ${message}`, otherwise `err.message`.

### Decisions this plan is making

1. **`@ticketbox/api` becomes a `workspace:*` devDependency of `@ticketbox/web`, and the types are imported by path: `import type { EventDto } from "@ticketbox/api/src/presentation/dto/events.js"`.** The handbook's folder structure is fixed — no third `packages/contracts`. A devDependency plus `import type` is erased by both `tsc` and Vite, so nothing of the API ships to the browser; `verbatimModuleSyntax` makes a non-type import of that module a compile error unless written as a value import, which the lint rule in decision 2 rejects. No `exports` map on `packages/api`: deep paths are what the lint rule names, and an export map would be a second place to keep in sync.
2. **The web lint block says exactly what web may take from api.** `no-restricted-imports` on `packages/web/src/**`: `@ticketbox/api/*` is forbidden except `@ticketbox/api/src/presentation/dto/*`, and that exception has `allowTypeImports: true` with the value form still forbidden (ESLint 10's core rule carries the option — verified in the installed source). This answers TB-009's follow-up: web may import **DTO types** and nothing else — not `domain/`, not a schema, not a mapper. The bypasses TB-009 enumerated (`import()`, `typeof import()`) get the same `no-restricted-syntax` ban in the web block. Each rule is proven by a trial file that goes red before the branch is pushed, as TB-009 did.
3. **The acceptance line is lint too.** `no-restricted-syntax` on `packages/web/src/**` except `src/api/**`: ~~a `CallExpression` whose callee is the identifier `fetch` is an error~~ _(review, Major)_ **the identifier `fetch` anywhere is an error** — the call-shape selector let `window.fetch`, `globalThis.fetch` and `const f = fetch` through; the widened selector was proven on all four spellings ("raw fetch outside src/api/ — use the client"). `EventSource` and `WebSocket` are not banned now; TB-038 decides where SSE lives.
4. **Tests inject `fetch`; nothing is stubbed on `globalThis`.** `createApiClient(fetchFn)` takes the function; tests pass one that returns a `Response` built with Node 22's global `Response`. Vitest runs in `environment: "node"` — the client touches no DOM. This is also why the client is a factory rather than bare module functions: the pages use the `api` instance, the tests build their own.
5. **Three TypeScript programs in `packages/web`, not two.** `vitest`'s types reach `vite`'s, and `vite`'s carry the `/// <reference types="node" />` that TB-014's Critical found. Test files therefore get `tsconfig.test.json` (DOM lib, includes `test/**`, pulls `src/api/**` transitively) and never join the browser program; `typecheck` runs all three. _(review)_ The test program **does** see Node's types, through `vitest/config` → `vite`; that is correct (tests run in Node) and a `types: []` that pretended otherwise was removed. The leak probe from TB-014 is re-run against `src/**` after this change.
6. **`vitest` is the one package added to `packages/web`** (same `^4.1.11` as the API). The Tests line demands unit tests for web; there is no way to run them without a runner, and splitting from the API's version would be a second thing to upgrade. No `jsdom`, no testing library: the hook is not unit-tested here (it needs a renderer), and the reviewer's "abort before the body is read" case is tested at the client level — a non-OK response whose body read rejects with `AbortError` makes `getEvent` reject with that `AbortError`, not an `ApiError`. The hook's own guard is covered by TB-016's E2E (no console errors across the flow).
7. **`statusText` is not trusted.** When there is no envelope, the message is ~~`HTTP <status>`~~ _(review)_ `no error details` — the hook already prefixes the status, and "502 HTTP 502" said it twice; `statusText` is empty under HTTP/2, and a message that varies with the transport is not a message.
8. **The currency `TODO(tech-debt)` from TB-014 stays open.** Adding `currency` to `TierResponse` is a DTO change on the API side; this task's Scope is the client, and the TODO says where the change belongs. Raised here so it is a decision, not an omission.

### New or changed ports / Redis keys / Lua scripts

None.

---

## 4. Files

| File                                         | New / Changed                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/web/src/api/client.ts`             | New                                                                                             |
| `packages/web/src/api/types.ts`              | Deleted — replaced by the shared DTO types                                                      |
| `packages/web/src/hooks/useRequest.ts`       | Renamed from `useFetch.ts`; takes `(key, load)` instead of a URL                                |
| `packages/web/src/pages/EventListPage.tsx`   | Changed — `useRequest("", (s) => api.listEvents(s))`                                            |
| `packages/web/src/pages/EventDetailPage.tsx` | Changed — `useRequest(id, (s) => api.getEvent(id, s))`                                          |
| `packages/web/test/unit/api/client.test.ts`  | New                                                                                             |
| `packages/web/vitest.unit.config.ts`         | New                                                                                             |
| `packages/web/tsconfig.test.json`            | New (decision 5)                                                                                |
| `packages/web/package.json`                  | Changed — `@ticketbox/api: workspace:*`, `vitest`, `test:unit`, `typecheck` runs three programs |
| `eslint.config.js`                           | Changed — the `packages/web` block (decisions 2, 3)                                             |
| `pnpm-lock.yaml`                             | Changed                                                                                         |

---

## 5. Test plan

| Level | Test                                                                                                                                                        | What it would catch                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Unit  | `getEvent` parses a 200 body into the DTO shape and calls `/api/events/<id>` with the id encoded                                                            | a wrong path, a dropped field                            |
| Unit  | `listEvents` parses a 200 array                                                                                                                             | same, for the list                                       |
| Unit  | a 404 with the envelope → rejects with `ApiError{status: 404, code: "NOT_FOUND", message}`                                                                  | a 404 surfacing as a generic error or as data            |
| Unit  | a 500 with no JSON body → `ApiError{status: 500, code: "HTTP_500", message: "HTTP 500"}`                                                                    | the envelope parse throwing on a non-JSON body           |
| Unit  | a body read that rejects with `AbortError` on a non-OK response → rejects with that `AbortError`                                                            | TB-014's Major 2 regressing into the client              |
| Unit  | a network failure from `fetchFn` → rejects with the same error                                                                                              | the client wrapping a transport error as an `ApiError`   |
| Lint  | trial files: a value import of the DTO module, an import of `api/src/domain/…`, a `fetch(` in a page, a dynamic `import()` — each goes red, then is deleted | the acceptance line and decision 2 silently not enforced |

**Concurrency:** N/A.

**How the tests will be proven able to fail:** break the client (drop the `!ok` branch; return `statusText` instead of the envelope message; swallow the abort) and watch the matching tests go red.

---

## 6. Risks and failure modes

- **What if Redis is down?** Nothing here touches Redis.
- **What if the API is down?** `fetchFn` rejects with a `TypeError`; the client rethrows it; the page shows `Could not load: <message>` with Try again (TB-014's observed behaviour, unchanged).
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Reads only. Two concurrent `getEvent` calls are two requests; the hook's guard drops the stale one.
- **What if it dies halfway through?** A body read that fails rejects into the error state; an aborted one is rethrown as `AbortError` and the hook's guard drops it.
- **The DTO changes on the API side without the web moving:** `tsc` fails in `packages/web` — that is the point of sharing the type rather than mirroring it (CLAUDE.md: a DTO change moves both packages in one PR).
- **The browser imports a Zod schema:** lint error (decision 2); and `verbatimModuleSyntax` would keep it as a runtime import, so the bundle size would also show it.

---

## 7. Could Postgres already do this?

Not a Redis task.

---

## 8. Open questions

None blocking. Decision 1 (deep type import from `@ticketbox/api/src/…` rather than an export map or a shared package) and decision 6 (adding `vitest` to web) are the ones a reviewer may want done differently.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-015-typed-api-client.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
