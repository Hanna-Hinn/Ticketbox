# TB-016 — First E2E

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-016 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-016-first-e2e.md`](../implementation-plans/TB-016-first-e2e.md)
**Branch / PR:** `feat/TB-016-first-e2e` · [#19](https://github.com/Hanna-Hinn/Ticketbox/pull/19) (based on #18)
**ADR:** none.

---

## What this task delivered

The fourth test level. `pnpm test:e2e` drives the real web app in Chromium against the real API and database: load `/`, see three event cards, click one, see three tier rows reading exactly `1000 of 1000`, `200 of 200`, `Sold out`, with one document load for the journey and no browser errors. CI's `integration` job now serves the web app next to the API, installs Chromium and runs the spec after smoke, in the handbook's order; that also makes the sixth smoke assertion real. Stage 3 is complete.

---

## How it works

```
pnpm test:e2e  →  packages/web/playwright.config.ts
   webServer[0]  WEB_URL              reuseExistingServer; else: "the web app is not answering at … - start it with: pnpm dev:web", exit 1
   webServer[1]  WEB_URL/api/health   same, for the API — through the proxy, the only path the browser uses
   testDir e2e/  · retries 0 · trace retain-on-failure · reporter github in CI, list locally

e2e/e2e-1-browse-events.spec.ts
   listeners before goto:  console "error" + pageerror → browserErrors;  load → documentLoads
   goto /  →  event-list visible, 3 × event-card
   click first card's link  →  URL /events/<jazz>, 3 × tier-row, tier-remaining toHaveText([exact ×3])
   documentLoads === 1  (a full navigation fires a second load; pushState does not)
   browserErrors deep-equals []

CI integration job
   pnpm install → playwright install --with-deps chromium → compose up → migrate → seed → test:integration
   → API + web in the background, both gated → test:smoke (6 real-or-todo, #6 now real) → test:e2e
   on failure: compose logs, api.log, web.log, test-results/ as an artifact
```

Playwright starts nothing. `reuseExistingServer: true` with a `command` that prints one line and exits 1 means a missing server fails the run in about two seconds with its name and URL, instead of a 30-second navigation timeout or a second stack booted against the wrong database. The reviewer traced the mechanism in Playwright's web-server plugin: the process exit races the URL poll and wins.

### Layers touched

| Layer          | What changed                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| L1–L4 (`api`)  | None                                                                                                                           |
| `packages/web` | `playwright.config.ts`, `e2e/e2e-1-browse-events.spec.ts`, `@playwright/test@1.56.1`, `test:e2e`, `tsconfig.test.json` include |
| `packages/api` | `test/smoke/smoke.test.ts`: #6 real; `vitest.smoke.config.ts` comment                                                          |
| CI / root      | `ci.yml` (install, web server, E2E, artifact), root `test:e2e`, `.gitignore`, two doc lines                                    |

### Key files

| File                                           | What it does                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/web/playwright.config.ts`            | The two gates, no retries, traces on failure                             |
| `packages/web/e2e/e2e-1-browse-events.spec.ts` | E2E-1                                                                    |
| `packages/api/test/smoke/smoke.test.ts`        | #6: `GET SMOKE_WEB_URL/` is 200, `text/html`, contains `<div id="root">` |
| `.github/workflows/ci.yml`                     | Browser install before the stack; two background servers; E2E step       |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                         | What actually happened                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| "no reload" proven by `performance.getEntriesByType("navigation").length === 1` | That count is per document: it is 1 after a full navigation or a reload too. The reviewer proved it live (1 / 1 / 1 / 1 across in-app click, full navigation, reload) — the assertion could never fail. The spec now counts `load` events; a `Link` without `preventDefault` makes it 2 (S2 below).                                                                                       | Review, Critical. Handbook §4.3: a test must be able to fail. The plan specified a tautology. |
| Gate the API at `E2E_API_URL/health`                                            | The browser reaches the API only through Vite's proxy, so the gate is `WEB_URL/api/health` — one URL proves web server, proxy and API — and the `E2E_API_URL` knob nobody set is gone.                                                                                                                                                                                                    | Review, Major.                                                                                |
| "the failure says which URL" when Postgres is down                              | It said "not reachable — start pnpm dev:api" for a server that was up with a failing health check. The message now names the URL and both causes.                                                                                                                                                                                                                                         | Review, Major.                                                                                |
| "zero console messages of type error"                                           | An uncaught exception is a `pageerror`, not a console message (reviewer proved: a `setTimeout` throw reached neither). Both now feed `browserErrors`; S4 below shows the path red.                                                                                                                                                                                                        | Review, Major.                                                                                |
| `projects: [chromium]`, `playwright-report/` ignored, install after smoke       | Removed, removed, moved before `docker compose up` so a download failure is cheap and plainly not the code's.                                                                                                                                                                                                                                                                             | Review, Minor.                                                                                |
| Smoke "needs the API"                                                           | Needs the web app too; `vitest.smoke.config.ts`, `CLAUDE.md` and `README.md` say "api and web running". The plan's §4 named `SMOKE_WEB_URL` for CI; the default is right there, so it is not set.                                                                                                                                                                                         | Review, Minor.                                                                                |
| —                                                                               | Plan decisions 1 (pin 1.56.1), 2 (start nothing), 4 (no retries), 6 (dev server in CI), 7 (test program) were approved by blanket go-ahead and first challenged at review; all held. Decision 1's honest downside, in the reviewer's words: the pin fits this container; the repo-level rule is "the lockfile's version, installed by `playwright install`", which holds for any version. | Recorded, not smoothed over.                                                                  |

---

## 4. Tests shipped

| Level | Test file                                      | Behaviour asserted                                                                                           |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| E2E   | `packages/web/e2e/e2e-1-browse-events.spec.ts` | E2E-1 as above; one document load; no console errors and no uncaught exceptions                              |
| Smoke | `packages/api/test/smoke/smoke.test.ts` #6     | the web root is 200, `text/html`, carries `<div id="root">` — the app shell, not merely "something answered" |

Observed: locally `1 passed (1.7s)`; smoke `4 passed | 2 todo`; **in CI** on the first head, Chromium build 1194 downloaded to the runner and `1 passed (2.8s)` ([run 39048011580](https://github.com/Hanna-Hinn/Ticketbox/actions/runs/39048011580)); the final head's run is linked from the PR.

**Proven able to fail** — seven sabotages, each restored, suites green after:

```
S1: "Sold out" → "0 of 0" in the expected array        1 failed — toHaveText: Expected -1 / Received +1   (exact, not substring)
S2: Link.tsx without event.preventDefault()            1 failed — documentLoads: Expected 1, Received 2   (the assertion the plan's version could not fail)
S4: setTimeout(() => { throw }) in a detail-page effect 1 failed — browserErrors: Expected [] (+4 lines received; the pageerror path)
S5a: SMOKE_WEB_URL=http://localhost:5999 (dead port)   1 failed — smoke #6, connection refused
S5b: SMOKE_WEB_URL=http://localhost:3000 (the API)     1 failed — smoke #6, expected 404 to be 200
S6: API stopped, web up                                "the API is not answering at http://localhost:5173/api/health (…) - start it with: pnpm dev:api", exit 1, ~2 s
S3: web stopped                                        "the web app is not answering at http://localhost:5173 (…) - start it with: pnpm dev:web", exit 1, ~2 s
```

**Coverage after this task:** unchanged; E2E is not instrumented.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It probed the live app with `playwright-core` to disprove the navigation-entry assertion, proved `pageerror` is not a console message, traced Playwright's web-server plugin for the fail-fast mechanism and timed it, read the `toHaveText` array matcher's source for exact-vs-substring, and listed the browser program's files to confirm no Node or Playwright types reach it.
**Verdict:** NEEDS WORK → fixed → re-reviewed (gates and the fail-fast re-run on the head) → **SAFE TO MERGE**

| Finding                                                                       | Severity | Resolution                                             |
| ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| Navigation-entry count is per document; the "no reload" assertion cannot fail | Critical | `load` counter; plan amended; S2 proves it red         |
| `E2E_API_URL` gates a server the browser never talks to directly              | Major    | Gate `WEB_URL/api/health`; knob deleted                |
| "not reachable" is wrong when the health check fails                          | Major    | Message names URL and both causes                      |
| Console listener misses uncaught exceptions                                   | Major    | `pageerror` → `browserErrors`; S4 proves it red        |
| One-entry `projects`; unused `playwright-report/` ignore                      | Minor    | Removed                                                |
| Browser install after the servers                                             | Minor    | Right after `pnpm install`                             |
| Docs say smoke needs one server                                               | Minor    | Three doc lines updated; `SMOKE_WEB_URL` default noted |
| `github` reporter prepends `dot`; role-within-testid; em dash in `node -e`    | Minor    | Known; acceptable; hyphen                              |

Findings deliberately **not** fixed: the reporter and role-within-testid rows.

---

## 6. Failure modes, as built

- **Redis down:** nothing on this path touches Redis.
- **Postgres down:** `/health` is 503 through the proxy; the API gate fails in ~2 s with the URL and "not started, or its health check is failing".
- **Web app not started:** the web gate fails first, naming `pnpm dev:web` (S3).
- **API not started:** the proxied health request is a 500 from Vite; the API gate fails naming `pnpm dev:api` (S6).
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** reads only.
- **Dies halfway through:** a failed spec leaves a trace in `test-results/` (ignored by git, uploaded by CI).
- **A flake:** red, with `retries: 0`; TB-037 is where it gets fixed, not hidden.

---

## 7. What I'd do differently

Probe an assertion before writing it into a plan. "Navigation entries === 1" sounded like a no-reload proof and was a constant; thirty seconds with a browser would have shown it, the way the reviewer's thirty seconds did.

---

## 8. Follow-ups left behind

- [ ] **TB-025 (E2E-2 partial), TB-027 (E2E-3), TB-030 (E2E-5), TB-038 (E2E-4), TB-037 (all five stable):** the four remaining specs use this config; keep `data-testid` selectors and the `browserErrors` + `documentLoads` pattern.
- [ ] **Bumping `@playwright/test`:** one version change in `packages/web/package.json`, then `pnpm --filter @ticketbox/web exec playwright install chromium` locally (the container's `/opt/pw-browsers` holds build 1194 only).
- [ ] **CI time:** if `playwright install` becomes the slow step, cache `~/.cache/ms-playwright` keyed on the lockfile — not before it hurts.
- [ ] **Smoke #1:** still asserts `postgres` only; TB-017 adds `redis`.
