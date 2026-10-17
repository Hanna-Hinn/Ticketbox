# TB-016 — First E2E

**Status:** Implemented — see [`docs/tasks/TB-016-first-e2e.md`](../tasks/TB-016-first-e2e.md) §3 for where reality diverged
**Date:** 2026-10-17
**Task:** TB-016 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-016-first-e2e` (stacked on `feat/TB-015-typed-api-client`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** Playwright configured against the compose stack. **E2E-1:** load the home page → see the event list → click an event → see three tiers with availability numbers.

**Acceptance:** `pnpm test:e2e` passes locally and in CI.

**Tests:** **E2E-1.**

**Depends on:** TB-014, TB-015 (open, PRs #17 and #18, below this branch in the stack) — confirmed: ☑ ancestors of this branch

---

## 2. What I understand this to mean

The fourth test level arrives: a real browser driving the real web app against the real API and the real database, with nothing faked. One spec, E2E-1, the read path. Playwright is the tool the handbook names; `packages/web/e2e/` is where the handbook's folder sketch puts the specs; CI already runs the stack for smoke and gains an E2E step after it, in the handbook's order (`… → test:smoke → test:e2e`). This task also closes Stage 3 and makes the sixth smoke assertion real, because CI will now serve the web root.

"Against the compose stack" means the test assumes the API and web server are up, the way smoke does; it does not start Postgres. Locally that is `./scripts/dev-up.sh`, `pnpm dev:api`, `pnpm dev:web`, `pnpm test:e2e`.

---

## 3. Approach

### Layers touched

| Layer          | What changes                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| L1–L4 (`api`)  | None                                                                                                              |
| `packages/web` | `playwright.config.ts`; `e2e/e2e-1-browse-events.spec.ts`; `@playwright/test` devDependency; `test:e2e` script    |
| `packages/api` | `test/smoke/smoke.test.ts`: the sixth todo becomes a real assertion against `SMOKE_WEB_URL`                       |
| CI             | `integration` job: start the web dev server next to the API, pass the web URL to smoke, install Chromium, run E2E |
| root           | `test:e2e` script                                                                                                 |

### E2E-1

```
goto /                              → [data-testid="event-list"] visible, 3 × [data-testid="event-card"]
click the first card's link          → URL /events/11111111-1111-4111-8111-111111111111 (the seeded jazz id)
                                     → 3 × [data-testid="tier-row"]
                                     → [data-testid="tier-remaining"] texts === ["1000 of 1000", "200 of 200", "Sold out"]
                                     → ~~performance navigation entries === 1~~ _(review, Critical: that count is 1 after a reload too — a per-document value)_
                                     → exactly one document `load` event for the whole journey (a full navigation fires one, pushState does not)
throughout                           → zero console messages of type "error" and zero `pageerror`s _(review: an uncaught exception is not a console message)_
```

Selectors are `data-testid` only (the frontend brief's rule; TB-014 put them on the list, card, tier row and remaining cell). The three exact strings are the acceptance of "three tiers with availability numbers": the seed is fixed (`SEED_EVENTS`), the jazz event has 1000/200/0, and the string form is what TB-014's task doc recorded from the browser.

### Decisions this plan is making

1. **`@playwright/test` pinned to `1.56.1`, not the registry's `1.64.1`.** The session's container ships Chromium build 1194 at `/opt/pw-browsers`, which is the browser `1.56.1` expects, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set there; pinning the matching runner means the suite runs locally with no download and no `executablePath` hack in the config. CI installs the same build with `playwright install --with-deps chromium`. Bumping is one version change plus a browser install, and the task doc says so. The alternative — pin latest and special-case the container's browser path in config — couples the repo to one machine.
2. **Playwright starts nothing; it `reuseExistingServer`s both.** The config's `webServer` entries point at ~~the API's `/health`~~ _(review, Major: the browser only reaches the API through Vite's proxy, so the gate is `WEB_URL/api/health` — one URL proves web server, proxy rule and API, and the `E2E_API_URL` knob nobody set is gone)_ and the web root with `reuseExistingServer: true` and a short timeout, so locally the test fails fast with "server not reachable" rather than silently booting a second stack with the wrong database, and in CI the servers the smoke step already started are reused. Starting Postgres from Playwright would make "against the compose stack" untrue.
3. **Chromium only.** One project, headless. Three browsers would triple the slowest level's time for a read-path spec that tests wiring, not rendering engines.
4. **No retries.** TB-037's Scope says "fix flakes properly — no retries masking a real race"; a `retries: 0` baseline is what makes TB-037 meaningful. `trace: "retain-on-failure"` so a red run in CI leaves something to read.
5. **Smoke #6 becomes real in this task.** CI now runs the web dev server for Playwright, so "the web app's root HTML is served" is answerable: `GET SMOKE_WEB_URL/` is 200, `text/html`, and the body contains `<div id="root">`. `SMOKE_WEB_URL` defaults to `http://localhost:5173`; locally smoke needs `pnpm dev:web` running, which the test's name says. The todo was re-pointed from TB-014 to TB-016 for exactly this.
6. **The web dev server in CI, not a built preview.** `vite` dev is what `pnpm dev:web` runs and what the proxy config belongs to; `vite preview` would need its own proxy configuration (a second place for the `/api` rule). The build is still exercised by the `checks` job's `pnpm build`. If E2E time or flakiness ever points at the dev server, `preview` with a shared proxy config is the change.
7. **The `e2e/` files join `tsconfig.test.json`'s program**, with `playwright.config.ts`. They run in Node and `@playwright/test` brings Node's types; the browser program stays untouched. The TB-014 probe is re-run against `src/**`.
8. **`pnpm test:e2e` at the root is `pnpm --filter @ticketbox/web test:e2e`.** `-r --if-present` would also work but every other level's root script names its package; mirror that.

### New or changed ports / Redis keys / Lua scripts

None.

---

## 4. Files

| File                                                            | New / Changed                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/web/playwright.config.ts`                             | New                                                                                                                                        |
| `packages/web/e2e/e2e-1-browse-events.spec.ts`                  | New                                                                                                                                        |
| `packages/web/package.json`                                     | Changed — `@playwright/test`, `test:e2e`                                                                                                   |
| `packages/web/tsconfig.test.json`                               | Changed — include `e2e/**`, `playwright.config.ts`                                                                                         |
| `packages/api/test/smoke/smoke.test.ts`                         | Changed — smoke #6 real, `SMOKE_WEB_URL`                                                                                                   |
| `.github/workflows/ci.yml`                                      | Changed — web server, Chromium install (right after `pnpm install`, per review), E2E; `SMOKE_WEB_URL` not set — the default is right in CI |
| root `package.json`                                             | Changed — `test:e2e`                                                                                                                       |
| `.gitignore`                                                    | Changed — `test-results/` only _(review: no reporter here writes `playwright-report/`)_                                                    |
| `packages/api/vitest.smoke.config.ts`, `CLAUDE.md`, `README.md` | Changed _(review)_ — smoke now needs the web app too; the three places that said "api running" say so                                      |
| `pnpm-lock.yaml`                                                | Changed                                                                                                                                    |

---

## 5. Test plan

| Level | Test                       | What it would catch                                        |
| ----- | -------------------------- | ---------------------------------------------------------- |
| E2E   | E2E-1 as above             | the read path broken anywhere from the browser to Postgres |
| Smoke | #6: the web root is served | a web server that is up but serving nothing                |

**Concurrency:** N/A.

**How the tests will be proven able to fail:** E2E-1 — change one expected string (`"Sold out"` → `"0 of 0"`) and watch it fail on the exact-text assertion; run it with the web server stopped and watch the `webServer` check fail fast. Smoke #6 — `SMOKE_WEB_URL` pointed at a dead port.

---

## 6. Risks and failure modes

- **What if Redis is down?** Nothing on the read path touches Redis yet.
- **What if Postgres is down?** `/health` is 503, so Playwright's API `webServer` check fails before any spec runs. _(review, Major)_ The message cannot tell "not started" from "health check failing" — it now says both, with the URL.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Reads only; two E2E runs share nothing but the seed.
- **What if it dies halfway through?** A failed spec leaves a trace in `test-results/`, ignored by git.
- **Flakiness:** the dev server's first request compiles on demand; Playwright's default navigation timeout (30 s) covers it, and the `webServer` health check means the server is up before the spec starts. No retries (decision 4), so a flake is red and visible.
- **The seed changes:** the three strings change with it; that is one line in the spec and a deliberate edit, which is what an exact assertion is for.

---

## 7. Could Postgres already do this?

Not a Redis task.

---

## 8. Open questions

None blocking. Decision 1 (the pinned Playwright version) is the one a reviewer may want done differently.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-016-first-e2e.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
- ☑ README / tracker: Stage 3 complete
