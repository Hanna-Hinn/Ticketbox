# TB-014 — Vite React app with two pages

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-014 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-014-vite-react-app.md`](../implementation-plans/TB-014-vite-react-app.md)
**Branch / PR:** `feat/TB-014-vite-react-app` · [#17](https://github.com/Hanna-Hinn/Ticketbox/pull/17) (based on #16)
**ADR:** none.

---

## What this task delivered

A browser can browse the box office. `pnpm dev:web` serves a Vite + React + TypeScript app with the two read-only Stage 3 screens: the event list at `/` and the event detail at `/events/:id` with tiers, prices and the API's `remaining` (the seeded-0 VIP tier reads "Sold out"). Loading and error states with a working "Try again", in-app navigation with back/forward, and a `/api` dev proxy so the browser talks to one origin. Nothing in the browser computes anything.

---

## How it works

```
index.html → main.tsx → <App>
  usePath()            pathname as state; navigate() = pushState + notify; popstate → setPath
  <Screen path>        "/"            → <EventListPage>        useFetch("/api/events")
                       "/events/:id"  → <EventDetailPage key>  useFetch("/api/events/:id")
                       else           → "Nothing at …"
  useFetch(url)        loading → loaded | error     every write through an abort guard (settle)
                       retry() bumps `attempt`, which is in the effect's deps → re-fetch
  Link                 real <a href>; plain left-click → navigate(); modifier keys fall through

vite.config.ts         /api/* → http://localhost:3000/* (prefix stripped; the API has no prefix)
tsconfig.json          src/** only — browser program, types: ["vite/client"]
tsconfig.node.json     vite.config.ts only — so Vite's reference to @types/node never reaches src/**
```

The two tsconfigs are the part worth remembering. Vite's type definitions carry `/// <reference types="node" />`, and a triple-slash reference from any file in a program is global to that program; `types: [...]` only limits automatic `@types/*` inclusion. One program for config and source means `process.cwd()` typechecks inside a component and throws in the browser. The review proved it with a probe file; the split is what the stock Vite template does for the same reason.

### Layers touched

| Layer          | What changed                                                                    |
| -------------- | ------------------------------------------------------------------------------- |
| L1–L4 (`api`)  | None (one smoke `it.todo` renamed)                                              |
| `packages/web` | Everything under `src/`, `index.html`, `vite.config.ts`, two tsconfigs, scripts |

### Key files

| File                                     | What it does                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/web/src/hooks/usePath.ts`      | The 25-line router: `usePath()`, `navigate()`                                        |
| `packages/web/src/hooks/useFetch.ts`     | The one loading/loaded/error machine, abort-guarded; `fetch` lives here until TB-015 |
| `packages/web/src/components/Link.tsx`   | `<a>` that navigates in-app on a plain click                                         |
| `packages/web/src/components/Status.tsx` | `Loading`, `ErrorMessage` (+ "Try again")                                            |
| `packages/web/src/pages/*.tsx`           | The two screens; `data-testid` on list, card, tier row, remaining cell               |
| `packages/web/src/api/types.ts`          | Local mirrors of `EventSummaryDto` / `EventDto` until TB-015 shares them             |
| `packages/web/src/format.ts`             | `Intl` price and date formatting; EUR is a stated assumption                         |
| `packages/web/src/styles.css`            | The one stylesheet, 68 lines                                                         |
| `packages/web/tsconfig.node.json`        | The config file's own program                                                        |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                        | What actually happened                                                                                                                                                                                                                                 | Why                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Decision 6: "the `types: ["node"]` mistake TB-001 removed is not reintroduced" | It was, by a side door: `vite.config.ts` in the browser program. A probe `process.cwd()` in `src/` compiled (exit 0). Split into two programs; the probe now fails with `TS2591`.                                                                      | Review, Critical. `types: [...]` does not stop a triple-slash reference.                                                           |
| `fetch` in the two page components                                             | In `hooks/useFetch.ts`, shared by both pages, with `Status.tsx` and `format.ts` extracted alongside. The second copy of a 15-line state machine is the point at which extraction stops being premature.                                                | Phase 2 plan change, recorded in the plan's §4; the reviewer agreed. TB-015 should absorb `useFetch`'s `fetch`, not sit beside it. |
| "an unmounted page ignores a late response"                                    | True on the success path only. A non-OK response whose body read was aborted inside `describeError` resolved to a message and wrote state for a dead effect (StrictMode's first run is exactly this). Every write now goes through one `settle` guard. | Review, Major.                                                                                                                     |
| Decision 5: "the seed prices are euros"                                        | The seed names no currency; EUR was a guess written as a fact. The comment now says it is a UI assumption, with `TODO(tech-debt)` to add `currency` to the DTO when TB-015 shares the types.                                                           | Review, Major — the Prime Directive at the level of a comment.                                                                     |
| §6: a double-click is absorbed by React's same-string bail-out                 | It is absorbed by `navigate` returning early when the path is already current; that is what prevents the duplicate history entry.                                                                                                                      | Review, Minor; the mechanism was misdescribed.                                                                                     |
| —                                                                              | `key={id}` on `<EventDetailPage>` so `/events/a` → `/events/b` remounts instead of showing a's data for one frame; proxy key `^/api/` so `/apiX` is not proxied.                                                                                       | Review, Minor.                                                                                                                     |
| —                                                                              | The browser logged a 404 for `/favicon.ico` on every first load. An empty `data:,` icon in `index.html` removes the only non-deliberate console error.                                                                                                 | Found by the Phase 5 evidence run.                                                                                                 |
| —                                                                              | Plan decisions 1, 3 and 5–7 were approved by blanket go-ahead and first challenged by the reviewer; 5 and 6 did not hold as written.                                                                                                                   | Recorded, not smoothed over.                                                                                                       |

---

## 4. Tests shipped

The Tests line is **none yet (TB-016 covers it)**. What stands in for tests until then:

| Check                                                     | Result                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm typecheck` (both web programs + api)                | clean; probe `process.cwd()` in `src/` → `TS2591` (the gate is back) |
| `pnpm lint --max-warnings 0` (covers `.tsx`)              | clean                                                                |
| `pnpm build` (`vite build` in CI's `checks` job)          | `dist/assets/index-*.js 223 kB`, built; CI green on every head       |
| Playwright 1.56 (pre-installed) against the running stack | below                                                                |

**Acceptance evidence, observed** (script in the session scratchpad, not shipped; TB-016 writes the real E2E-1):

```
1 list cards: ["Rooftop Jazz Night","Late Night Comedy","Indie Film Marathon"]
2 url after click: "http://localhost:5173/events/11111111-1111-4111-8111-111111111111"
2 tier-remaining: ["1000 of 1000","200 of 200","Sold out"]
2 navigation entries (1 = no full reload): 1
3 back → url: "http://localhost:5173/"            navigation entries: 1
3 forward → url: ".../events/11111111-…"          navigation entries: 1
4 api down → alert: "Could not load: 502 Bad Gateway Try again"
4 try again → tier-remaining: ["1000 of 1000","200 of 200","Sold out"]
4 navigation entries (still 1 = recovered without reload): 1
5 console errors: [the 502 from step 4 only, after the favicon fix]
   (filtered by level, `type() === "error"`: React's dev-mode DevTools line is `info` and is not counted)
```

Headless Chromium `--dump-dom` of the error states: `/events/not-a-uuid` → `Could not load: 400 params/id Invalid UUID`; an unknown UUID → `404 event … not found`; `/nowhere` → `Nothing at /nowhere`.

**Proven able to fail:** not applicable — no test was shipped. The typecheck gate was proven to fail (the probe), which is the one check this task added.

**Coverage after this task:** unchanged for `packages/api`; `packages/web` has no unit runner until TB-015.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It compiled a probe file against the branch's compiler options with and without `vite.config.ts` in the program, rendered all five screen states in headless Chromium, and ran lint, typecheck, prettier and `vite build`.
**Verdict:** NEEDS WORK → fixed → re-reviewed twice (on `43bdefc`, then on `6335b93` after the favicon line; the reviewer re-ran the probe, typecheck, lint, build and the headless render each time) → **SAFE TO MERGE**

| Finding                                                                      | Severity | Resolution                                                                  |
| ---------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `vite.config.ts` in the browser program re-admits Node ambient types         | Critical | `tsconfig.node.json`; `typecheck` runs both programs; probe goes red        |
| `describeError` swallows the abort → a write for a dead effect               | Major    | `settle` guard on every write                                               |
| "the seed prices are euros" is not in the repository                         | Major    | Comment states the assumption; `TODO(tech-debt)` for a DTO `currency` field |
| No `key` on the detail page across `/events/a` → `/events/b`                 | Minor    | `key={id}`                                                                  |
| Proxy prefix `"/api"` also matches `/apiX`                                   | Minor    | `"^/api/"`                                                                  |
| Plan §6 misdescribes the double-click mechanism                              | Minor    | Plan amended, recorded above                                                |
| Dead `event.button` check; `useCallback` unnecessary; `useSyncExternalStore` | Minor    | Left — each is one clause and the current form is the standard one          |
| `statusText` is empty under HTTP/2                                           | Minor    | TB-015's central error handling                                             |
| `<th>` without `scope="col"`                                                 | Minor    | Left                                                                        |

Findings deliberately **not** fixed: the last three rows.

On "zero business logic": the reviewer's reading, which this doc adopts — `remaining === 0 ? "Sold out" : …` is a label for a server value; the two sins the rule names are computing availability and deciding expiry, and neither happens. The line to watch is TB-025, when a quantity exists to compare against.

---

## 6. Failure modes, as built

- **Redis down:** nothing here touches Redis.
- **Postgres down / API down:** the page shows `Could not load: <status> <message>` with "Try again"; Try again re-fetches and recovers in place (observed: 502 while the API was stopped, loaded after restart, one navigation entry throughout).
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** reads only; a repeated `navigate` to the current path is a no-op; StrictMode's double effect aborts the first fetch and the guard drops its writes.
- **Dies halfway through:** a fetch that fails rejects into the error state; an unmounted page's response is dropped by the guard on every path.
- **The browser types something it cannot run:** closed — Node globals no longer typecheck in `src/**`.

---

## 7. What I'd do differently

Treat "the config file typechecks" as a question, not a result. It typechecked because of a reference it pulled in for everyone, and the plan's decision 6 claimed the opposite without a probe. The review's probe took thirty seconds.

---

## 8. Follow-ups left behind

- [ ] **TB-015:** typed client in `src/api/`, absorbing `useFetch`'s `fetch`; shared DTO types replace `api/types.ts`; `statusText` fallback; decide the web↔api lint rule (TB-009 follow-up); unit test the abort-before-body-read path and the error envelope parsing.
- [ ] **TB-015 / DTO:** `TODO(tech-debt)` in `format.ts` — add `currency` to `TierResponse` so the browser stops assuming EUR (api and web move in the same PR).
- [ ] **TB-016:** E2E-1 as the reviewer specified — `data-testid` only, exactly `["1000 of 1000","200 of 200","Sold out"]`, one navigation entry, zero console errors; make smoke #6 (web root) real once CI serves the web app.
- [ ] **TB-025:** when a button is disabled for `remaining === 0`, it is still presentation; the moment `remaining` is compared to a quantity, the rule belongs in `TicketTier.canFulfil`.
