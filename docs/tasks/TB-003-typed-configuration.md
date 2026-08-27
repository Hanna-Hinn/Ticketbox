# TB-003 — Typed configuration

**Status:** Merged
**Date completed:** 2026-08-27
**Task:** TB-003 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-003-typed-configuration.md`](../implementation-plans/TB-003-typed-configuration.md)
**Branch / PR:** `feat/TB-003-typed-configuration` · (PR not yet opened)
**ADR:** none — no Redis/Postgres mechanism decision here.

---

## What this task delivered

`packages/api/src/main/config.ts` — a Zod schema validating `DATABASE_URL`, `REDIS_URL`, and `PORT` (defaulting to `3000`) from `process.env`, throwing a formatted, readable error naming exactly what's missing or malformed, and exporting a frozen, correctly-typed config object. Nothing consumes it yet — TB-011 (Fastify) and TB-012 (composition root) are the first real callers.

---

## How it works

```ts
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // formats result.error.issues into a "  - PATH: message" line per issue
    throw new Error(`Invalid configuration:\n${lines}\n\nCheck your .env against .env.example.`);
  }
  return Object.freeze(result.data);
}

export const config: Config = loadConfig(process.env);
```

`loadConfig` is a pure function — the actual boot-time behavior ("crash immediately with a readable message") comes from the top-level `config` export calling it against the real `process.env` at module-import time.

### Layers touched

| Layer        | What changed     |
| ------------ | ---------------- |
| L1–L3        | None             |
| L4 `main/**` | New: `config.ts` |

### Key files

| File                                         | What it does                                              |
| -------------------------------------------- | --------------------------------------------------------- |
| `packages/api/src/main/config.ts`            | The schema, `loadConfig()`, the top-level `config` export |
| `packages/api/test/unit/main/config.test.ts` | 7 unit tests, see §4                                      |
| `.env.example`                               | Added `PORT=3000` (optional — documented as such)         |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                                                | What actually happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod's exact API (`.issues` vs `.errors`, coercion behavior) "will be verified for real once installed" | Verified via a throwaway probe script before writing the real module: `result.error.issues` (not `.errors`), each with `.path`/`.message`; `z.coerce.number()` correctly rejects `"not-a-number"` (reports `invalid_type`, doesn't silently pass `NaN` through as a number) and correctly range-checks `"99999"` and `""` (`Number("")` is `0`, caught by `.min(1)`). Confirmed exactly as hoped — no surprises this time, unlike TB-001's TypeScript 7 wall.                                                                                                                                                        | Plan explicitly flagged this as unverified; verifying it before writing real code is what the plan said would happen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| No file beyond §4's table (`config.ts`, `config.test.ts`, `package.json`, `.env.example`)              | **A necessary, unplanned addition appeared, then got removed again after code review.** Importing `config.ts` for its `loadConfig` named export also executes the module's top-level `export const config = loadConfig(process.env)` line — ES modules evaluate top-to-bottom regardless of which export is used. Without valid ambient `DATABASE_URL`/`REDIS_URL`, importing the module at all (even just to test `loadConfig`) would throw before any test ran. First fix: a project-wide `test/unit/setup.ts` + `setupFiles` entry in `vitest.unit.config.ts`, injecting ambient values for the whole unit suite. | Discovered while writing the test file, not anticipated in the plan. Flagged in the plan's own §3 as something the design would need, but the specific mechanism (a global setup file) wasn't decided until implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —                                                                                                      | **Code review (Major) correctly rejected the global setup-file approach**: `setupFiles` applies to every file matching `include`, not just `config.test.ts` — meaning every future `test/unit/**` file (starting at TB-006) would silently inherit `DATABASE_URL`/`REDIS_URL` mutated into its `process.env`, violating `CLAUDE.md`'s explicit "no shared mutable state between tests." Also correctly flagged that `setup.ts` and the `vitest.unit.config.ts` edit weren't in the plan's file list, and should have been surfaced as a plan amendment rather than landed quietly.                                   | Fixed by rewriting `config.test.ts` to use `vi.stubEnv` + a dynamic `import()` inside `beforeAll`, with `vi.unstubAllEnvs()` in `afterEach` — scoped entirely to this one file. This **removed** `test/unit/setup.ts` and the `vitest.unit.config.ts` edit outright, which resolved the plan-file-list divergence too: there's nothing left outside the approved table. Re-verified: both "prove it can fail" sabotage passes re-run against the new structure, same results (1 test fails when the range check is loosened; 4 fail when the throw branch is disabled). The reviewer independently re-broke the code itself on the re-review pass rather than trusting the report — genuinely caught, genuinely fixed, genuinely re-verified. |

---

## 4. Tests shipped

| Level | Test file                                    | Behaviour asserted                                                                                                                                                                                |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit  | `packages/api/test/unit/main/config.test.ts` | Valid env parses; `PORT` defaults to 3000; config is frozen; missing `DATABASE_URL` throws naming it; missing `REDIS_URL` throws naming it; non-numeric `PORT` throws; out-of-range `PORT` throws |

**Proven able to fail — three separate proofs, each broken deliberately and reverted:**

1. **The literal Acceptance line, verified outside the test harness entirely.** A throwaway script deleted `process.env.DATABASE_URL` for real and imported the real module fresh:
   ```
   Threw as expected:
   Invalid configuration:
     - DATABASE_URL: Invalid input: expected string, received undefined

   Check your .env against .env.example.
   ```
2. Loosened the `PORT` schema (dropped `.min(1).max(65535)`) → exactly the one test exercising the range check failed, the other 7 stayed green. Restored, diffed byte-for-byte against a backup to confirm the restoration was exact.
3. Disabled the error-throwing branch (`if (false && !result.success)`) → exactly the 4 tests behind `toThrowError` failed, the 4 valid-path tests stayed green. Restored.

Both sabotage proofs (2 and 3) were **re-run a second time** after the test file was rewritten in response to code review, to confirm the rewrite didn't quietly weaken anything. Same results both times. The reviewer also independently re-broke the code itself during the re-review pass and confirmed the same result before giving SAFE TO MERGE — not just re-reading the claim.

**Coverage:** not measured against the global thresholds this task — `main/**` isn't `domain/`, `application/`, or `infrastructure/`, so it falls under the 80% global floor rather than the 90% gate, and nothing yet in this repo runs `--coverage`.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool
**Verdict:** NEEDS WORK → fixed → re-reviewed (reviewer independently re-broke the code to confirm) → **SAFE TO MERGE**

| Finding                                                                                                                                                                                                                                                 | Severity | Resolution                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `test/unit/setup.ts` + a project-wide `setupFiles` entry mutate `process.env` for every unit test in the suite, not just `config.test.ts` — violates "no shared mutable state between tests" and would silently affect every future `test/unit/**` file | Major    | Fixed — replaced with `vi.stubEnv`/dynamic-import scoped to `config.test.ts` alone; the global files are gone entirely |
| `setup.ts` and the `vitest.unit.config.ts` edit weren't in the approved plan's file list                                                                                                                                                                | Major    | Resolved as a side effect of the fix above — nothing outside the approved file list remains                            |

Findings deliberately not fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** N/A — this module never connects to anything.
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** `loadConfig` is pure and idempotent — calling it twice with the same input always returns an equivalent frozen object. Importing `config.ts` twice hits the module cache; the top-level line only actually runs once.
- **Dies halfway through:** Can't — synchronous, all-or-nothing.

---

## 7. What I'd do differently

Would have anticipated the ES-module top-level-evaluation problem while writing the plan, not while writing the test — the plan's own §3 already reasoned carefully about testability ("a pure `loadConfig(env)` function... standard, much more testable shape"), one step short of noticing that _importing the file at all_ still runs the top-level line. Would have saved a review round-trip.

---

## 8. Follow-ups left behind

- [ ] Nothing automatically tests the top-level `export const config = loadConfig(process.env)` line's own behavior with a genuinely-absent `process.env.DATABASE_URL` — only `loadConfig` called directly with constructed env objects. The real-boot scenario was verified manually (§4, proof 1) but isn't a permanent regression test. Deliberately not added: doing so cleanly needs `vi.resetModules()` plus careful handling of "unset a var" (which `vi.stubEnv` doesn't directly support — it stubs to a value, not to "absent"), adding real complexity for a one-line pass-through to an already-exhaustively-tested pure function. Revisit if `config.ts` ever grows past a thin wrapper.
