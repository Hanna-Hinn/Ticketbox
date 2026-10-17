# TB-028a — E2E: the expiry journey

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-028a (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-028a-e2e-expiry-journey` (stacked on `spike/TB-028-keyspace-notifications-flushdb`, which is stacked on `feat/TB-027-reconciliation-endpoint`; the task needs TB-026)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decisions 1 and 2 are the ones to read first**: the E2E stack's TTL, and the spec adapting to whatever the TTL is.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

**Scope:** **E2E-3** — get tickets, let the timer run out, assert availability returns to its original value without any user action. Use a test-only short TTL via config.

**Acceptance:** _(none stated; the Scope line is the assertion)_

**Tests:** **E2E-3.**

**Depends on:** TB-026 — confirmed merged: ☐ (stacked: #30 is open, not merged, by the session's instruction; this branch contains it)

---

## 2. What I understand this to mean

The handbook's E2E-3, "TTL + sweeper + reconciliation, the hardest feature", as one Playwright spec: a person takes tickets, does nothing, the timer runs out, and the number on the event page goes back up by itself — the TTL drops the hash, the countdown asks the server once and is told the hold is gone, the sweeper restores the quantity from the index, and the page shows the original number. Nobody clicks Release. "Without any user action" means no release and no reconcile; reading the page again is observation, not action — the page does not update itself until TB-038's live UI. The two-minute TTL would make the spec a two-minute wait, so the stack the E2E suite runs against gets a short `HOLD_TTL_MS` through the config knob TB-025 added for exactly this — and the worker, which no E2E stack has run until now.

---

## 3. Approach

### Layers touched

| Layer        | What changes                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1–L4        | nothing — no application code                                                                                                                      |
| web `e2e/`   | `e2e-3-expiry.spec.ts` (new); `e2e-2-hold-and-release.spec.ts` and `e2e-2b-hold-failure-paths.spec.ts` lose their assumption that the TTL is 120 s |
| CI           | `.github/workflows/ci.yml`: the API started with `HOLD_TTL_MS=8000`, the worker started beside it, its log printed on failure                      |
| `playwright` | `playwright.config.ts`: a comment on the worker and the TTL; nothing Playwright can check for a process with no port                               |

### Decisions this plan is making

1. **The E2E stack's TTL is 8 s, set in CI only.** `HOLD_TTL_MS=8000` on the API process the workflow starts for smoke and E2E; the dev stack keeps the handbook's 120 s and `.env.example` already documents the knob. Why 8 and not 3: E2E-2 and E2E-2b take a hold and then look at it for two or three seconds (the countdown must tick, the summary render, the clock jump happen) before releasing it; a 3 s hold would expire under them. Why not 30: E2E-3 waits for the TTL plus a sweeper tick (5 s) plus a poll, and 8 + 5 + margin keeps the spec under twenty seconds. The number is a CI line, not code.

2. **E2E-3 adapts to whatever the TTL is, so it is correct against the dev stack too — just slow.** After landing on checkout the spec asks the API (`GET /api/holds/:token`, the proxy the browser uses) for `remainingMs` and sets its own timeout from it: `test.setTimeout(remainingMs + 30_000)`. Against the 120 s dev stack the spec passes in ~2.2 minutes; against CI's 8 s in ~15. The spec never hardcodes a TTL and never computes one from `expiresAt` — the server says how long is left, which is also how the countdown works (TB-025).

3. **The spec asserts the journey, in order.** (a) the event page shows `1000 of 1000`; (b) get 1 ticket, land on checkout, countdown visible; (c) the checkout page shows `hold-gone` on its own — the countdown reaches zero, asks once, is told 404 — within `remainingMs + 5 s`, with **no** DELETE issued (the spec records every request to `/api/holds/` and asserts none was a DELETE); (d) the event page, reloaded, shows `1000 of 1000` within 20 s more (one sweeper tick is 5 s; the poll is `expect.poll` on the page's text with a reload between polls, not a sleep). The failure message when (d) times out names the worker: "availability did not return — is the sweeper running (pnpm dev:worker)?". The `afterEach` release stays as a safety net; on this spec it is a no-op because the sweeper already took the hold.

4. **The two existing hold specs stop assuming 120 s.** `/^1:5\d$/` becomes `/^\d+:\d\d$/` plus "not `0:00`" where the countdown is first read, and the "then a lower value" assertion stays. In 2b, the clock-jump test's "remounts at `1:5x`" becomes "remounts at a non-zero m:ss", and the at-zero test's `runFor(2 * 60_000)` stays (it only needs to be at least the TTL). Nothing else in them depends on the TTL. This is the plan's one change to existing tests, and it is what decision 1 forces.

5. **CI starts the worker the same way it starts the API** — `tsx src/worker/sweeper.ts` in the background, `worker.log` printed on failure — in the same step, before the health wait. The worker has no port, so the health gate stays on `/health` and the web root; a worker that failed to start shows up as E2E-3's own failure message and `worker.log` in the job output. The smoke suite does not need the worker and is unchanged.

6. **No application code, no config change, no new npm package.** `HOLD_TTL_MS` exists (TB-025); the worker exists (TB-026); `page.clock` is not needed here — real time is the point of this spec.

7. **Not E2E-3's job:** the browser updating without a reload (TB-038, E2E-4), reconcile (the spike proved it by hand; it has composition tests), persistence (TB-040).

### New or changed ports

None.

### Redis keys

None.

### Lua scripts

None.

### Migrations

None.

---

## 4. Files

| File                                                    | New / Changed | Why                                                   |
| ------------------------------------------------------- | ------------- | ----------------------------------------------------- |
| `packages/web/e2e/e2e-3-expiry.spec.ts`                 | New           | decisions 2, 3                                        |
| `packages/web/e2e/e2e-2-hold-and-release.spec.ts`       | Changed       | decision 4                                            |
| `packages/web/e2e/e2e-2b-hold-failure-paths.spec.ts`    | Changed       | decision 4                                            |
| `packages/web/playwright.config.ts`                     | Changed       | the comment: the worker and the TTL the suite expects |
| `.github/workflows/ci.yml`                              | Changed       | decisions 1, 5                                        |
| `docs/tasks/TB-016-first-e2e.md`, `docs/tasks/TB-026-…` | Changed       | the E2E-3 follow-ups, closed                          |
| `docs/02-product-delivery-plan.md`                      | Changed       | tracker                                               |

---

## 5. Test plan

| Level | Test                                                                                                                                             | What it would catch                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E   | **E2E-3** (decision 3): 1000 → hold 1 → checkout → `hold-gone` by itself, no DELETE sent → the event page reads 1000 again within a sweeper tick | a TTL that does not drop the hash; a countdown that never asks; a sweeper that does not restore; a page that does not read the live counter |
| E2E   | E2E-2 and E2E-2b unchanged in meaning, TTL-agnostic in wording, green against the 8 s stack                                                      | the existing journeys surviving decision 1                                                                                                  |
| Smoke | unchanged                                                                                                                                        |                                                                                                                                             |

**Concurrency:** no inventory path is added; the sweeper's concurrency test is TB-026's.

**How each test will be proven able to fail:** the worker not running (E2E-3 red at (d), with the message naming it); `HOLD_TTL_MS` left at 120 s with the spec's timeout forced to 30 s (red at (c) — the timer never runs out in time — proving the spec really waits for the real TTL); a DELETE injected before (c) (red at the no-DELETE assertion). Each run locally against the API started with `HOLD_TTL_MS=8000`.

---

## 6. Risks and failure modes

- **What if Redis is down?** The spec fails at (b): `POST /holds` is a 500. Not this task's.
- **What if a key is evicted under `allkeys-lru`?** Not a CI condition; the dev Redis has no `maxmemory`. If the index were evicted mid-spec, (d) would time out with the worker message — misleading, and TB-040's territory.
- **What if this operation runs twice?** The spec is serial (`workers: 1`) and leaves the counter at 1000; a second run finds the same world.
- **What if it dies halfway through?** A spec that dies between (b) and (c) leaves a hold the sweeper takes 8 s later; `afterEach` releases it anyway. The next spec starts from 1000 either way.
- **Flakiness:** (c) is bounded by the server's own `remainingMs` plus 5 s; (d) by 20 s against a 5 s tick. The active expiry cycle's lag (TB-028: 38–127 ms on an idle server) is inside both margins. The clock the spec reads is the server's, through `remainingMs`; the browser's clock is not consulted.
- **CI time:** the E2E job grows by ~15 s.

---

## 7. Could Postgres already do this?

Not applicable: no Redis capability is added. The spec exists to prove the one that was.

---

## 8. Open questions

None blocking. Decision 1's number (8 s) is the one to argue; decision 2 is why it does not matter to the spec's correctness.

---

## 9. Documentation this task will produce

- ☐ ADR — none; no decision beyond a CI line
- ☐ Task doc — `docs/tasks/TB-028a-e2e-expiry-journey.md`
- ☐ Benchmark entry — nothing measurable changed
- ☐ NOTES entry — not a SPIKE task
