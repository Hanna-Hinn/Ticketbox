# TB-001 — Repository scaffold

**Status:** Merged
**Date completed:** 2026-08-22
**Task:** TB-001 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-001-repository-scaffold.md`](../implementation-plans/TB-001-repository-scaffold.md)
**Branch / PR:** `feat/TB-001-repository-scaffold` · (PR not yet opened)
**ADR:** none — see §3 for why the module-system decision doesn't meet the ADR bar, and §3 again for why the TypeScript version constraint doesn't either

---

## What this task delivered

A pnpm workspace with `packages/api` and `packages/web` as members, strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) enforced across both, ESLint flat config failing on any warning, Vitest with separate unit/integration configs, and a Husky pre-commit + commit-msg gate that actually rejects a non-Conventional-Commit message. Everything is ESM.

There is still no application code — that's correct. TB-006 (domain) and TB-014 (Vite/React) are what give `packages/api` and `packages/web` real content.

---

## How it works

```
pnpm lint            → eslint . --max-warnings 0            (root, whole repo)
pnpm typecheck        → pnpm -r --if-present run typecheck    (delegates; only api has the script)
pnpm test:unit        → pnpm -r --if-present run test:unit    (delegates; only api has the script)
pnpm test:integration → pnpm -r --if-present run test:integration

git commit  →  .husky/pre-commit  → lint-staged (eslint --fix, prettier --write on staged files)
            →  .husky/commit-msg  → commitlint --edit (rejects non-Conventional messages)
```

`pnpm -r --if-present` is the load-bearing idiom here: it runs a script in every workspace package that defines it and silently skips the ones that don't, rather than hardcoding `--filter @ticketbox/api`. That means `packages/web` picking up its own `typecheck`/`test:unit` scripts later (TB-014/TB-016) needs zero changes to the root scripts.

### Layers touched

| Layer                                     | What changed             |
| ----------------------------------------- | ------------------------ |
| L1 `domain/**`                            | None — doesn't exist yet |
| L2 `application/**`                       | None — doesn't exist yet |
| L3 `infrastructure/**`, `presentation/**` | None                     |
| L4 `main/**`, `worker/**`                 | None                     |

Pure tooling. No Clean Architecture layering applies yet.

### Key files

| File                                                             | What it does                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`, root `package.json`                       | Workspace definition, root scripts, `packageManager` pin                                                                                             |
| `tsconfig.base.json`                                             | Shared strict compiler options both packages extend                                                                                                  |
| `packages/api/tsconfig.json`                                     | `NodeNext` module/resolution — Node ESM                                                                                                              |
| `packages/web/tsconfig.json`                                     | `ESNext`/`Bundler` — no `typecheck` script wired yet (empty `src/`, see §3)                                                                          |
| `eslint.config.js`                                               | Flat config; `strict`+`stylistic` (non-type-checked) typescript-eslint presets, plus explicit `no-console`/`no-explicit-any`/`no-non-null-assertion` |
| `packages/api/vitest.unit.config.ts`                             | Coverage thresholds mirroring `CLAUDE.md`'s gates (90/90/70/80), only active under `--coverage`                                                      |
| `packages/api/vitest.integration.config.ts`                      | Separate config, no `setupFiles` yet (nothing to set up)                                                                                             |
| `.husky/pre-commit`, `.husky/commit-msg`, `commitlint.config.js` | The commit gate                                                                                                                                      |

### Redis keys / Lua scripts introduced

None — no Redis usage exists yet.

---

## 3. Where this diverged from the plan

| Planned                                                                               | What actually happened                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Record the exact pnpm version resolved via corepack"                                 | `corepack enable` / `corepack prepare pnpm@latest --activate` both failed: `EPERM: operation not permitted, open 'C:\Program Files\nodejs\pnpm'` — this Node install's corepack tries to place its shim next to `node.exe` itself, which isn't user-writable without elevation. Fell back to `npm install -g pnpm`, which installs into the user-writable npm prefix instead. Resolved to **pnpm 11.22.0**, pinned in `packageManager`.                    | A real environment constraint, not a choice — worth recording so a future setup on a similarly-locked-down machine doesn't re-diagnose the same `EPERM` from scratch.                                                                                                                                                                                                                                                                                                                                                   |
| Module system: ESM system-wide (per approval)                                         | Delivered exactly as approved. `packages/api` uses `NodeNext`; both packages carry `"type": "module"`; `eslint.config.js`/`commitlint.config.js` use `import`/`export default`.                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| "TypeScript strict... ESLint + Prettier" (no version pinned in the plan)              | `pnpm add` resolved **TypeScript 7.0.2** and **typescript-eslint 8.67.0** — and typescript-eslint's own entry point hard-refuses to load against TS 7: `"typescript-eslint does not support TS 7.0"` (`pnpm lint` exited 2, not a lint failure — a load-time crash). Its declared peer range is `>=4.8.4 <6.1.0`. Downgraded `typescript` to **6.0.3** (the top of that range) in the root and both packages. Tracked upstream: `typescript-eslint#10940`. | Nobody could have caught this from the plan alone — it only appeared once real registry resolution happened. This is exactly the kind of thing "record the exact version, don't guess" was protecting against, just from an angle the plan didn't anticipate: the ecosystem had already moved to a new TS major that its own tooling hadn't caught up to yet.                                                                                                                                                           |
| "ESLint... `@typescript-eslint` strict rules" (type-checked vs. not left open)        | Used the **non-type-checked** `strict`/`stylistic` presets (no `projectService`), not `strictTypeChecked`/`stylisticTypeChecked`.                                                                                                                                                                                                                                                                                                                          | Decided during implementation, for two compounding reasons: (1) with `domain/`, `application/`, `infrastructure/` all still empty, there's no typed business logic yet for type-aware linting to protect; (2) type-checked linting depends much more heavily on TypeScript's internals than parser-only linting, so it would have been more exposed to the TS 7 incompatibility above, not less. Flagged in a comment in `eslint.config.js` itself, and worth reconsidering at TB-009, which already touches this file. |
| File list didn't mention a `typecheck` script for `packages/web` one way or the other | No script added. Verified directly: `tsc --noEmit` against an empty `src/**/*.ts` glob throws `TS18003: No inputs were found`. Confirms the reasoning already in the plan (§2 — "a script pointing at nothing is worse than no script") was correct, not just a hedge.                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 4. Tests shipped

| Level       | Test file                                | Behaviour asserted                                                                             |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unit        | `packages/api/test/unit/example.test.ts` | The Vitest unit runner, TS transform, and `pnpm test:unit` wiring complete a trivial assertion |
| Integration | none (config only)                       | N/A — no adapters exist yet; `--passWithNoTests` confirmed exit 0 with zero test files         |

**Proven able to fail** — three separate proofs, each broken deliberately and reverted:

1. Changed the trivial test's assertion to `toBe(3)` → `pnpm test:unit` failed with a real `AssertionError`, exit 1. Reverted.
2. Added a throwaway file using `any`, `console.log`, and a non-null assertion → `pnpm lint` caught all three by name (plus an unrelated `no-unused-vars` hit), exit 1. Deleted.
3. Attempted `git commit -m "fixed stuff"` → commitlint rejected it (`subject may not be empty`, `type may not be empty`), exit 1.

```
AssertionError: expected 2 to be 3 // Object.is equality
 ❯ test/unit/example.test.ts:5:19

packages/api/src/_lint-probe.ts
  1:14  error  Unexpected any. Specify a different type     @typescript-eslint/no-explicit-any
  2:1   error  Unexpected console statement                 no-console
  3:7   error  'forced' is assigned a value but never used  @typescript-eslint/no-unused-vars
  3:16  error  Forbidden non-null assertion                 @typescript-eslint/no-non-null-assertion

✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]
```

**Coverage after this task:** not applicable — `domain/**`/`application/**`/`infrastructure/**` don't exist yet, so the thresholds in `vitest.unit.config.ts` have nothing to measure. They're wired and correct for the moment code lands there.

---

## 5. Code review outcome

**Reviewer:** self-applied `engineering-code-reviewer` rubric (Agent tool not invoked — not requested for this task)
**Verdict:** NEEDS WORK → fixed → re-reviewed → SAFE TO MERGE

| Finding                                                                                                                                                                                                                      | Severity | Resolution                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `packages/web/tsconfig.json` declared `"types": ["node"]`, copied from `packages/api` without adapting it — `@types/node` isn't installed there, and `web` is a browser target so Node ambient types don't belong regardless | Critical | Fixed — removed                                                         |
| `eslint.config.js`'s `**/node_modules/**` and `**/.husky/**` ignore entries were dead (verified: ESLint 10 ignores `node_modules` by default; `.husky`'s extensionless files never match any rule config here)               | Major    | Fixed — removed; `dist`/`coverage` kept (both can hold generated `.js`) |

Both fixes re-verified against `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` — all green — before committing.

Findings deliberately not fixed: none.

---

## 6. Failure modes, as built

- **Redis down:** N/A — no Redis client exists in this task.
- **Key evicted under `allkeys-lru`:** N/A — no Redis usage yet.
- **Operation runs twice:** `pnpm install`, and the commit hooks, are naturally idempotent; nothing here is a stateful operation that can double-apply. Not independently tested beyond normal use, since there's no state to corrupt.
- **Dies halfway through:** A partially-scaffolded repo is safe to re-run — confirmed in practice, since this task's own tsconfig bug (found by the code review) sat "half-wired" (declared but not exercised) for a full implementation cycle without breaking anything else.

---

## 7. What I'd do differently

Would have run `pnpm add` for the version-sensitive tools (`typescript`, `typescript-eslint`) as a first, tiny, isolated step and checked `pnpm peers check` _before_ writing any config that assumed a particular TypeScript major — rather than discovering the TS 7 incompatibility only once `pnpm lint` was run against a fully-written `eslint.config.js`. Would have saved zero real time here (the fix was one command), but it's the more disciplined order of operations for the next task that installs anything.

---

## 8. Follow-ups left behind

- [ ] Revisit non-type-checked ESLint (`strict`/`stylistic`) vs. full type-checked (`strictTypeChecked`/`stylisticTypeChecked` + `projectService`) once `domain/`/`application/` exist — natural fit for TB-009, which already touches `eslint.config.js`.
- [ ] Watch `typescript-eslint#10940` (TS 7 support) — once it lands, reconsider moving off the pinned TS 6.0.3 ceiling.
- [ ] `packages/web/tsconfig.json` will need real `types` (`vite/client`, not `node`) once TB-014 adds Vite — noted here so it isn't rediscovered as a surprise.
