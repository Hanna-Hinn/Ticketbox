# TB-028a — E2E: the expiry journey

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-028a (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-028a-e2e-expiry-journey.md`](../implementation-plans/TB-028a-e2e-expiry-journey.md)
**Branch / PR:** `feat/TB-028a-e2e-expiry-journey` · [#33](https://github.com/Hanna-Hinn/Ticketbox/pull/33) (based on #32, the TB-028 spike, on #31)
**ADR:** none, no decision needed

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

E2E-3, the handbook's "hardest feature" journey, as one Playwright spec: a person takes a ticket and does nothing; the checkout page says the hold is gone on its own, having sent no release; the event page reads `1000 of 1000` again within a sweeper tick. CI now runs the stack the journey needs — the API with an 8 s hold TTL through the knob TB-025 added, and the sweeper worker beside it, with its PID checked after the health gate — and the two existing hold specs no longer assume a two-minute TTL. The spec asks the server how long the hold has and waits that long, so it is correct against the 120 s dev stack too, just slow.

---

## How it works

```
event page  1000 of 1000 → Get tickets (1)
checkout    countdown visible; GET /api/holds/:token → remainingMs (the spec's own budget)
   …nobody clicks…
checkout    countdown reaches zero → asks once → 404 → "This hold has expired" (hold-gone); no DELETE was sent
event page  reloaded until it reads 1000 of 1000 (≤ 20 s: one sweeper tick is 5 s)
```

**The spec never knows the TTL.** It reads `remainingMs` from the API through the same proxy the browser uses, narrowed from `unknown` (a 404 envelope comes out `NaN` and fails), and sets its own timeout from it. CI's API runs with `HOLD_TTL_MS=8000`: the journey takes ~10 s. The dev stack's 120 s makes it ~2.2 min, and still green.

**"Without any user action" is proven as "no DELETE from the page".** Every request the page makes is recorded; none may be a `DELETE`. That proves the page never released; in a serial suite nothing else can restore the counter but the sweeper, which is the point. Its limit is stated in §4: a `request.delete` from the test fixture is invisible to `page.on("request")`.

**The two older specs stop assuming 120 s — without losing the one assertion that mattered.** `/^1:5\d$/` had been the only check that the countdown's first reading _is_ the server's `remainingMs`; the TTL-agnostic rewrite had dropped it. E2E-2 now asks the API and asserts the shown `m:ss` is within two seconds below the server's number (the browser fetched a moment earlier and has ticked since) and one above. It also asserts the release's own reply is `{"released":true}`, so a hold that expired under a slow runner fails as what it is.

**CI knows when the worker died.** The worker has no port, so the health gate cannot see it; but the shell that started it has its PID, and `kill -0` after the gate fails the boot step in seconds with `worker.log`, instead of E2E-3 half a minute later. `HOLD_TTL_MS` is set on the API line only: the sweeper works from the index's own scores and never reads it.

### Layers touched

| Layer        | What changed                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| L1–L4        | nothing                                                                                                                  |
| web `e2e/`   | `e2e-3-expiry.spec.ts` (new); `e2e-2-hold-and-release.spec.ts`, `e2e-2b-hold-failure-paths.spec.ts`: TTL-agnostic        |
| CI           | `.github/workflows/ci.yml`: the API with `HOLD_TTL_MS=8000`, the worker started and PID-checked, `worker.log` on failure |
| `playwright` | `playwright.config.ts`: the comment about the worker and the TTL                                                         |

### Key files

| File                                              | What it does                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/web/e2e/e2e-3-expiry.spec.ts`           | the journey; `remainingMsOf` narrows the body; the no-DELETE assertion; the poll with reload |
| `packages/web/e2e/e2e-2-hold-and-release.spec.ts` | the countdown bound against `remainingMs`; the release reply asserted                        |
| `.github/workflows/ci.yml`                        | the E2E stack: TTL, worker, PID check                                                        |

### Redis keys introduced

| Key  | Type | TTL | Who writes it | Who reads it |
| ---- | ---- | --- | ------------- | ------------ |
| none |      |     |               |              |

### Lua scripts introduced

| Script | The race it prevents |
| ------ | -------------------- |
| none   |                      |

---

## 3. Where this diverged from the plan

| Planned                                                       | What actually happened                                                                                                                                  | Why                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5: E2E-3 catches "a TTL that does not drop the hash"         | It cannot, and the row says so; the `create_hold.lua` integration test's `PTTL` assertion is the only guard                                             | **Review Major, demonstrated:** with `redis-cli persist` on every hold key during the spec it stayed green — `GetHold` answers not-found on `isExpired(now)` whether or not the key exists, and `sweep_hold.lua` deletes the hash itself. |
| Decision 4: `/^1:5\d$/` → `/^\d+:\d\d$/` + not `0:00` + moves | …plus the shown seconds bounded against the server's `remainingMs` (`[−2, +1]`), and the release reply asserted                                         | Review Major: the rewrite had removed the only test that the first reading is the server's number; nothing bounded it from below. The reply assertion makes an expiry under a slow runner fail by name.                                   |
| Decision 5: "nothing can check a process with no port"        | `WORKER_PID=$!` and `kill -0` after the health gate                                                                                                     | Review Major: true of Playwright, false of the shell that started it.                                                                                                                                                                     |
| `HOLD_TTL_MS=8000` on both the API and the worker lines       | On the API line only                                                                                                                                    | Review Minor: the sweeper never reads it; two lines implied a coupling.                                                                                                                                                                   |
| The spec read the hold body as `any` with an uncommented `as` | `unknown`, narrowed, the smoke suite's pattern                                                                                                          | Review Critical: both are banned; the non-type-aware ESLint cannot see them.                                                                                                                                                              |
| One sabotage script for Phase 4                               | Two: the first stopped its own shell — `pgrep -f` matched the script's command line, which contained the worker's path, and `kill -STOP` landed on bash | The TB-023 `pkill -f` lesson again. The rerun picks the worker's leaf by process name (`comm == "node"`), from a script file.                                                                                                             |

---

## 4. Tests shipped

| Level                      | Test file                               | Behaviour asserted                                                                                                                                                                    |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E                        | `e2e/e2e-3-expiry.spec.ts`              | **E2E-3**: 1000 → hold 1 → checkout → `hold-gone` by itself within the server's `remainingMs` + 5 s, no DELETE from the page → the event page reads 1000 within 20 s, still no DELETE |
| E2E                        | `e2e/e2e-2-hold-and-release.spec.ts`    | the countdown's first reading within `[ceil(remainingMs/1000) − 2, +1]` of the server's number and then lower; the release reply is `{"released":true}`; TTL-agnostic otherwise       |
| E2E                        | `e2e/e2e-2b-hold-failure-paths.spec.ts` | TTL-agnostic: the clock-jump remount is a non-zero `m:ss`                                                                                                                             |
| Unit / Integration / Smoke | —                                       | unchanged: api unit 196, api integration 219, smoke 6                                                                                                                                 |

Final run on `3139f96` against the local API and worker started with `HOLD_TTL_MS=8000`: E2E **8 passed** (E2E-3 in 9.7–14.6 s); typecheck clean, `lint --max-warnings 0` clean. CI on the same head: green, with the worker and the TTL in the workflow.

**Proven able to fail** — nine runs, each restored (the first batch froze itself; see §3):

```
S1  worker stopped (SIGSTOP on its leaf process)        E2E-3 ✘ at the poll, 28.7 s: "availability did not return — is the sweeper running (pnpm dev:worker)?"  999 of 1000
S2  worker crashing at boot (DATABASE_URL=not-a-url)   the CI step's kill -0 fails: "sweeper worker exited during boot" + worker.log ("Invalid configuration: DATABASE_URL: Invalid URL")
S3a a DELETE sent from the page before hold-gone       E2E-3 ✘ at expect(deletes).toEqual([]), 9.5 s
S3b a DELETE sent from the test's request fixture      E2E-3 ✓ — stays green: page.on("request") sees only the page's requests. The assertion's limit, on record.
S4  Countdown starting from remainingMs / 100          E2E-2 ✘: Expected >= 6, Received 1
S5  120 s stack, hold-gone timeout forced to 30 s      E2E-3 ✘ at toBeVisible after 30.7 s: the spec really waits for the server's TTL
S6  E2E-2 under a 1.5 s TTL                             ✓ (the hold-to-release window is ~1 s); under 0.5 s ✘ at the countdown's second reading — the element was gone: the expiry lands in whichever step is running; the release-reply assertion is the backstop for an expiry between the summary and the click
S7  PEXPIRE dropped from create_hold.lua               RedisHoldStore "gives the hold key the hold's TTL, within tolerance" ×  (E2E-3 would stay green — not its guard)
```

**Coverage after this task:** not measured — TB-042's gates.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran the spec four times against the live stack — baseline, worker `SIGSTOP`ped, hold TTL stripped mid-spec, the older specs for durations — and read Playwright's timeout manager and poll runner to settle the timing questions.
**Verdict:** **NEEDS WORK** (Critical: `any` and an uncommented `as` on the hold body) → fixed in `629ede3` with the four Majors → re-reviewed → **SAFE TO MERGE**.

| Finding                                                                              | Severity | Resolution                                                                                                    |
| ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `(await response.json())` is `any`; `as { remainingMs }` uncommented                 | Critical | `unknown` + narrowing in `remainingMsOf`; the token guarded with a throw                                      |
| §5 claimed the journey catches an immortal hash                                      | Major    | Withdrawn with the reason; the `PTTL` integration test named as the guard                                     |
| The TTL-agnostic rewrite lost the countdown-value assertion                          | Major    | E2E-2 bounds the first reading against `remainingMs`; a `Countdown` unit test is a follow-up                  |
| A worker dead at boot noticed only by E2E-3, 30 s later                              | Major    | `kill -0 $WORKER_PID` after the health gate                                                                   |
| An expiry under a slow runner would read as a release bug                            | Major    | The release reply asserted; the failure mode in plan §6                                                       |
| `HOLD_TTL_MS` on the worker line; `token ?? ""`; comment wording; `(c)`/`(d)` labels | Minor    | All applied                                                                                                   |
| `remainingMsOf` duplicated in two specs (re-review)                                  | Minor    | Left, matching the directory's style; the first thing to lift into `e2e/helpers.ts` when a third copy appears |

Findings deliberately **not** fixed: the duplicated helper, above.

---

## 6. Failure modes, as built

- **Redis down:** the spec fails at the hold (`POST /holds` 500). Not this task's.
- **Worker not running:** E2E-3 fails at the poll, by name, after ~29 s (tested). **Worker dead at boot:** the CI step fails in seconds with `worker.log` (tested). **Worker alive but Redis unreachable:** it logs "sweep failed" each tick and stays up; E2E-3's message catches it, `worker.log` in the dump.
- **Key evicted under `allkeys-lru`:** not a CI condition; an evicted index mid-spec would read as the worker message. TB-040.
- **Runs twice:** serial; every spec leaves the counter at 1000 (tested across the whole batch).
- **Dies halfway:** a hold left between the click and `hold-gone` is swept 8 s later; `afterEach` releases it only while the TTL has not passed.
- **The 8 s TTL under a slow runner:** E2E-2's window is ~1–2 s. Under 0.5 s the spec failed at the countdown's second reading (tested); between the summary and the click it would fail at the release reply. Either way the cause is in the message.
- **Timing margins:** `hold-gone` within `remainingMs + 5 s` against a countdown that ticks once a second and an expiry cycle that lags by ~100 ms (TB-028); the poll within 20 s against a 5 s tick. Both held across every run.

---

## 7. What I'd do differently

Ask what an assertion stopped proving before accepting its replacement. `/^1:5\d$/` looked like a hard-coded number and was the only test of the countdown's first value; the TTL-agnostic version read fine and proved less. And never match a process by its command line from a script whose command line contains the same words — twice now.

---

## 8. Follow-ups left behind

- [ ] A `Countdown` unit test in `packages/web/test/unit/components/`: the first render of `remainingMs: 119_400` is `2:00` and of `7_500` is `0:08` — the right home for "format ⇐ remainingMs", today proven only through E2E-2.
- [ ] `e2e/helpers.ts` for `remainingMsOf`, `CHECKOUT`, the token hooks — when a third spec copies them (TB-029's E2E-2 completion is the candidate).
- [ ] TB-038: the page updating without a reload (E2E-4); E2E-3's reload-in-poll goes away then.
- [ ] TB-037: the E2E suite's stability pass; the margins above are the numbers to revisit.
