# TB-003 — Typed configuration

**Status:** Implemented — see [`docs/tasks/TB-003-typed-configuration.md`](../tasks/TB-003-typed-configuration.md) for what actually happened, including a test-isolation fix the code review caught and a rewrite in response
**Date:** 2026-08-27
**Task:** TB-003 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-003-typed-configuration`
**Approved by:** Hanna
**Approved on:** 2026-08-27

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `main/config.ts` parsing `process.env` through a Zod schema. Exports a frozen typed object. Throws on start with a readable list of what's missing.

**Acceptance:** deleting `DATABASE_URL` produces an immediate, legible error.

**Tests:** **unit** — valid env parses; missing var throws; malformed port throws.

**Depends on:** TB-001 — merged (PR #2). Not formally dependent on TB-002, but consumes the env var names TB-002's `.env.example` already established (`DATABASE_URL`, `REDIS_URL`) — merged (PR #3).

---

## 2. What I understand this to mean

A single module, `packages/api/src/main/config.ts`, that reads `process.env` through a Zod schema once, at import time, and either exports a frozen, correctly-typed config object or throws an error naming exactly which variable is missing or malformed — before anything else in the app runs. Nothing consumes this config yet (Fastify doesn't exist until TB-011, the composition root doesn't exist until TB-012) — this task is purely the validation layer itself.

No design question here — no ports, no Redis/Postgres decision, nothing architectural. `engineering-backend-architect` isn't warranted; I'm writing this plan directly, same as TB-002.

---

## 3. Approach

### Layers touched

| Layer        | What changes     |
| ------------ | ---------------- |
| L1–L3        | None             |
| L4 `main/**` | New: `config.ts` |

`main/` is Layer 4 per §2.4 — it may import anything, so `zod` as a dependency here is unrestricted.

### New or changed ports / Redis keys / Lua scripts

None.

### Migrations

None.

### The schema

Three fields — the two env vars TB-002 already established, plus `PORT`, which this task introduces because its own Tests line explicitly names "malformed port throws" as a required case:

```ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
```

`PORT` defaults to `3000` — matching what `README.md`/`CLAUDE.md` already document for `pnpm dev:api` — so it doesn't need to be present in `.env` at all; only an explicitly-set, invalid value should throw.

### Decisions this plan is making

**A pure `loadConfig(env)` function, plus a top-level `export const config = loadConfig(process.env)`.** The Scope line says "exports a frozen typed object," which the top-level `config` export satisfies for real app code (`import { config } from './config.js'` gets boot-time validation for free, exactly as intended). But testing a module that reads the real `process.env` at import time is awkward — it forces `vi.resetModules()` gymnastics for every test case. Factoring the actual parsing logic into an exported, pure function that takes an env object as a parameter is a standard, much more testable shape, and it doesn't contradict anything in the Scope line — `config.ts` still exports the frozen object either way.

**Validation depth stops at "is it a URL" for `DATABASE_URL`/`REDIS_URL`, not "is it the _right kind_ of URL."** I considered also checking the scheme (`postgres://` / `redis://` specifically) to catch someone pasting the wrong connection string into the wrong variable. The task's own Scope line is about _missing_ variables ("a readable list of what's missing"); only `PORT` is named as needing stricter malformed-value checking. Scheme validation would be a reasonable addition but isn't what this task asks for — flagging it here rather than quietly adding it.

**Zod's exact API surface (`.issues` vs. `.errors`, whether `z.coerce.number()` correctly rejects non-numeric strings and not just accepts `NaN` as a number) will be verified for real once it's installed, not assumed from memory.** `zod` isn't a dependency yet. TB-001 already taught this project that assuming a library's exact behavior across versions is exactly how a plan goes sideways mid-implementation (TypeScript 7 vs. `typescript-eslint`'s support ceiling). Phase 2 will confirm the real installed version's error shape and coercion behavior with actual test cases before the implementation is considered done, not just written.

**Test file mirrors the source path**: `packages/api/test/unit/main/config.test.ts`, not a flat `test/unit/config.test.ts`. Not mandated by the Scope line, but this is the first real unit test in the repo (TB-001's `example.test.ts` was a placeholder proving the runner works) — establishing a mirrored structure now is a small, sensible precedent for TB-006 onward rather than something to reconsider later once there are a dozen flat test files.

**`TB-001`'s placeholder `test/unit/example.test.ts` is left alone.** It's now somewhat redundant — a real test exists — but it's not in this task's Scope or file list, so per "touch only what you must," it isn't this task's place to remove it. Noting it here rather than silently deleting it.

---

## 4. Files

| File                                         | New / Changed | Why                                                                          |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| `packages/api/src/main/config.ts`            | New           | The schema, `loadConfig()`, the top-level `config` export                    |
| `packages/api/test/unit/main/config.test.ts` | New           | The unit tests (see §5)                                                      |
| `packages/api/package.json`                  | Changed       | Add `zod` as a runtime dependency (not dev — this ships in application code) |
| `.env.example`                               | Changed       | Add `PORT=3000`                                                              |

Anything not in this table is out of scope — in particular, no Fastify, no composition root, nothing that actually _uses_ `config` yet.

---

## 5. Test plan

| Level       | Test                               | What it would catch                                                  |
| ----------- | ---------------------------------- | -------------------------------------------------------------------- |
| Unit        | `config.test.ts` — see cases below | A missing or malformed env var not producing a clear boot-time error |
| Integration | N/A                                | Nothing to integrate with — no adapter, no engine                    |
| Concurrency | N/A                                | No inventory logic                                                   |
| Smoke       | N/A — TB-013                       | —                                                                    |
| E2E         | N/A — TB-016                       | —                                                                    |

Cases, covering the task's three named scenarios plus the natural extensions:

1. **Valid env parses** — all three vars present and well-formed → returns a `Config` with the exact expected values, and `PORT` correctly coerced from string to number.
2. **`PORT` omitted uses the default** — proves the default mechanism, not just presence-checking.
3. **Missing `DATABASE_URL` throws** — the literal Acceptance line. Assert the thrown message names `DATABASE_URL` specifically, not just "something is wrong."
4. **Missing `REDIS_URL` throws** — same behavior, a second required var, proving it's general and not hardcoded to `DATABASE_URL`.
5. **Malformed `PORT` throws (non-numeric, e.g. `"not-a-number"`)** — the task's second named case.
6. **Malformed `PORT` throws (out of range, e.g. `"99999"` or `"0"`)** — a different way to be malformed; both need covering since they exercise different Zod checks (`.int()`/coercion vs. `.min()`/`.max()`).
7. **The returned config is actually frozen** — `Object.isFrozen(config)` — proving "frozen" isn't just a word in the Scope line.

**How this would be proven able to fail:** temporarily loosen the schema (e.g. `PORT: z.coerce.number()` with the range checks removed) and confirm case 6 goes red, then restore it. Temporarily change `loadConfig` to swallow the Zod error instead of rethrowing and confirm cases 3–6 all go red, then restore it.

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A — this module never connects to anything, it only validates shapes.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Importing `config.ts` twice hits Node's module cache — same frozen object both times. Re-calling `loadConfig()` directly (e.g., in a test) is a pure function and always safe to call again.
- **What if it dies halfway through?** Can't — `loadConfig` is synchronous; either the whole schema validates and the object is returned, or it throws before anything is exported.

---

## 7. Could Postgres already do this?

N/A — no Redis capability is being added.

---

## 8. Open questions

None blocking.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed. No Redis/Postgres mechanism decision here.
- ☑ Task doc — `docs/tasks/TB-003-typed-configuration.md` — always
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
