# TB-014 — Vite React app with two pages

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-014 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-014-vite-react-app` (stacked on `feat/TB-013-smoke-and-baseline`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** Vite + React + TS in `packages/web`. Event list page and event detail page. Plain CSS, one stylesheet. Loading and error states. Vite dev proxy to the API.

**Acceptance:** `pnpm dev:web` shows seeded events with tiers, prices, and availability. Zero business logic in components.

**Tests:** none yet (TB-016 covers it).

**Depends on:** TB-011 (open, PR #14, below this branch in the stack) — confirmed: ☑ ancestor of this branch

---

## 2. What I understand this to mean

`packages/web` has been an empty placeholder since TB-001. This task gives it a Vite + React + TypeScript app with exactly the two read-only screens handbook §3.3 lists for Stage 3: the event list at `/` (`GET /events`) and the event detail at `/events/:id` (`GET /events/:id`, with tiers, prices and the `remaining` number the API computed). No quantity picker, no "Get tickets", no countdown, no SSE — those are TB-025 and TB-038. The browser renders what the API said and decides nothing.

"Zero business logic" is the acceptance line that matters. The one place it is tempting here is availability: the page shows `remaining` as a number and shows "Sold out" when the API says 0. That is presenting a server value, not computing one; whether a hold can be made is never the browser's call.

---

## 3. Approach

### Layers touched

| Layer          | What changes                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| L1–L4 (`api`)  | None. The API is not touched; the Vite dev proxy reaches it at `http://localhost:3000`                                                |
| `packages/web` | New: Vite config, `index.html`, `src/main.tsx`, `src/App.tsx`, two pages, a `Link`, a `usePath` hook, one stylesheet, local DTO types |
| root           | `dev:web` script (README already documents it); `pnpm typecheck` / `pnpm build` pick up web through `-r --if-present` (TB-001)        |

### Screens

```
/                EventListPage     GET /api/events        → cards: name, venue, startsAt  → Link to /events/:id
/events/:id      EventDetailPage   GET /api/events/:id    → name, venue, startsAt, tier table: name · price · remaining/total ("Sold out" at 0)
anything else    "Not found"

each page:  loading  →  loaded | error (status + message, with a "Try again")
```

`/api/*` is the Vite dev proxy to `http://localhost:3000/*` (prefix stripped). The API has no `/api` prefix and gains none; the prefix exists only so the browser talks to one origin in dev and so the same relative URLs can later be served behind one reverse proxy.

### Decisions this plan is making

1. **No React Router. A 25-line `usePath` hook plus a `Link` component.** Two routes, one dynamic segment. `history.pushState` on click, `popstate` for back/forward, `location.pathname` as state. The handbook's rule is "no new npm packages without asking; if something is missing, write the twenty lines". The moment a third screen needs nested routes or route guards, this is the first thing to replace — and it will be a one-file change.
2. **The six packages this task adds are the stack the Scope line names, nothing else:** `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`. Pinned to the current majors (React 19, Vite 8). No `eslint-plugin-react-hooks`, no `react-refresh` plugin for lint, no testing library — none was asked for; TB-016 brings Playwright.
3. **`fetch` lives in the two page components for now, and TB-015 moves it.** TB-015's whole scope is the typed client ("no raw `fetch` call outside `api/`"); building it here would take that task's work. Each page has one `fetch` with a comment naming TB-015. Response types are two local interfaces in `src/api/types.ts` that mirror `EventSummaryDto` / `EventDto` field for field; TB-015 replaces them with the shared DTO types (and TB-009's follow-up says that is also when the web lint rule about importing from `api/` is decided).
4. **The API's `remaining` is rendered, never derived.** The tier row prints `remaining` and `total` from the DTO and the word "Sold out" when `remaining` is 0. No arithmetic, no comparison against a quantity, no disabling of anything (there is nothing to disable until TB-025).
5. **Money and dates are formatted with the platform, not a library.** `Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" })` on `priceCents / 100` (the seed prices are euros), `Intl.DateTimeFormat` for `startsAt`. The currency is a display assumption the DTO does not carry; said in a comment. _(review)_ The premise "the seed prices are euros" was unbacked — the seed names no currency. The comment now says EUR is a UI assumption with a `TODO(tech-debt)` to add `currency` to the DTO.
6. **Web `tsconfig.json` gains what Vite needs and keeps the base strictness:** `jsx: "react-jsx"`, `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `types: ["vite/client"]`, `noEmit`. The `types: ["node"]` mistake TB-001 removed is not reintroduced. _(review, Critical)_ Wrong in effect as first written: including `vite.config.ts` in the same program pulled Vite's `/// <reference types="node" />` into `src/**`, so `process.cwd()` typechecked in a component. Two programs now — `tsconfig.json` for `src/**`, `tsconfig.node.json` for the config file — and `typecheck` runs both. `typecheck` is `tsc -p tsconfig.json && tsc -p tsconfig.node.json` _(review: one program per tsconfig)_; `build` is `vite build` (the typecheck is already a separate CI step).
7. **Smoke assertion #6 moves from TB-014 to TB-016.** The TB-013 todo says "TB-014", but the smoke suite in CI runs against the API process only; nothing serves the web root there until TB-016 starts the web app for Playwright. The todo's name is updated here, in one line, so the hand-off is honest.
8. **Acceptance is verified with the pre-installed Chromium, not claimed.** `pnpm dev:api` + `pnpm dev:web` against the seeded local database, a Playwright script loads `/` and `/events/<jazz id>`, and the screenshots plus the DOM text go in the task doc. That script is a verification artefact for Phase 5, not a shipped test — TB-016 owns E2E-1.

### New or changed ports / Redis keys / Lua scripts

None.

---

## 4. Files

| File                                         | New / Changed                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web/package.json`                  | Changed — scripts `dev`, `build`, `typecheck`; the six deps                                                                                                       |
| `packages/web/tsconfig.node.json`            | New _(review, Critical)_ — the config file's own program, so Node types never reach `src/**`                                                                      |
| `packages/web/tsconfig.json`                 | Changed — jsx, DOM lib, vite/client types                                                                                                                         |
| `packages/web/vite.config.ts`                | New — react plugin, `/api` proxy                                                                                                                                  |
| `packages/web/index.html`                    | New; _(review)_ an empty `data:,` favicon so a first load logs no 404                                                                                             |
| `packages/web/src/main.tsx`                  | New — `createRoot`                                                                                                                                                |
| `packages/web/src/App.tsx`                   | New — route switch on `usePath()`                                                                                                                                 |
| `packages/web/src/hooks/usePath.ts`          | New — pathname state + `navigate`                                                                                                                                 |
| `packages/web/src/components/Link.tsx`       | New — `<a>` that calls `navigate`                                                                                                                                 |
| `packages/web/src/pages/EventListPage.tsx`   | New                                                                                                                                                               |
| `packages/web/src/pages/EventDetailPage.tsx` | New                                                                                                                                                               |
| `packages/web/src/api/types.ts`              | New — local mirrors of the two DTOs (until TB-015)                                                                                                                |
| `packages/web/src/hooks/useFetch.ts`         | New _(plan change, Phase 2)_ — the loading/loaded/error state machine both pages share; was going to be inlined per page, extracted when the second copy appeared |
| `packages/web/src/components/Status.tsx`     | New _(plan change, Phase 2)_ — `Loading` and `ErrorMessage` with "Try again"                                                                                      |
| `packages/web/src/format.ts`                 | New _(plan change, Phase 2)_ — decision 5's two `Intl` formatters, out of the page files                                                                          |
| `packages/web/src/styles.css`                | New — the one stylesheet                                                                                                                                          |
| root `package.json`                          | Changed — `dev:web`                                                                                                                                               |
| `packages/api/test/smoke/smoke.test.ts`      | Changed — todo #6 renamed to TB-016                                                                                                                               |
| `pnpm-lock.yaml`                             | Changed                                                                                                                                                           |

---

## 5. Test plan

The Tests line says **none yet**. What this task does instead:

| Check                                                                  | What it would catch                          |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm typecheck` includes `@ticketbox/web` (strict + DOM)              | a page reading a field the DTO does not have |
| `pnpm lint --max-warnings 0` covers `.tsx`                             | `any`, `!`, `console.log` in the UI          |
| `pnpm build` runs `vite build` in CI's `checks` job                    | a broken import that only the bundler sees   |
| Chromium against the real stack (decision 8), recorded in the task doc | the acceptance line itself                   |

**Concurrency:** N/A.

---

## 6. Risks and failure modes

- **What if Redis is down?** Nothing here touches Redis.
- **What if Postgres is down?** `GET /events` returns the 500 envelope; the page shows the error state with status and message and a "Try again".
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Reads only. A double-click on a card is two `navigate` calls to the same path; `navigate` returns early when the path is already current, so no duplicate history entry is pushed. _(review: the plan first said React's same-string bail-out would absorb it; the no-op in `navigate` is what actually prevents the second history entry.)_
- **What if it dies halfway through?** A fetch that fails mid-flight rejects; the page shows the error state. A component unmounted before its fetch resolves ignores the result (an `AbortController` per effect).
- **The browser computes something it should not:** the only candidates are "Sold out" (a label for the API's 0) and the formatted price (a representation of `priceCents`). Neither changes what the API would say.

---

## 7. Could Postgres already do this?

Not a Redis task. The only Redis-adjacent question is whether the page should poll for availability — no: SSE over Pub/Sub is TB-038's lesson, and polling here would pre-empt it.

---

## 8. Open questions

None blocking. Decision 1 (no router package) and decision 3 (`fetch` in pages until TB-015) are the ones a reviewer may want done differently.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-014-vite-react-app.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
