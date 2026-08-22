# TB-001 — Repository scaffold

**Status:** Approved
**Date:** 2026-08-22
**Task:** TB-001 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-001-repository-scaffold`
**Approved by:** Hanna
**Approved on:** 2026-08-22 — with one change: ESM instead of CommonJS, system-wide (see §3)

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** pnpm workspace with `packages/api` and `packages/web`. TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. ESLint + Prettier, `--max-warnings 0`. Vitest configured with separate `unit` and `integration` projects. Husky + lint-staged pre-commit. Conventional Commits enforced by commitlint.

**Acceptance:** `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` all run and pass on an empty suite. A commit with a bad message is rejected.

**Tests:** one trivial unit test proving the runner works.

**Depends on:** none — this is the first task.

---

## 2. What I understand this to mean

A repository where the tooling is fully strict from commit one: strict TypeScript, a linter that fails the build on any warning, a fast unit-test runner, and a pre-commit/commit-msg gate — with **no application code yet**. `packages/api` and `packages/web` exist as workspace members (a `package.json` and `tsconfig.json` each) but stay otherwise empty; their real content arrives in TB-006 (domain) and TB-014 (Vite/React) respectively. Retrofitting strictness onto code that already exists is the specific pain this task exists to avoid.

Two boundaries I'm holding to on purpose:

- **No layer-boundary ESLint rules yet** (`domain/**` import restrictions, etc.) — that's TB-009, explicitly gated on TB-008 (use cases) existing. Adding it now would be enforcing rules against folders that don't exist.
- **No Fastify server, no `dev:api`/`dev:worker`/`dev:web` scripts** — those point at entry files that don't exist until TB-011, TB-035, and TB-014. A script pointing at nothing is worse than no script.

---

## 3. Approach

### Layers touched

| Layer                                     | What changes                                 |
| ----------------------------------------- | -------------------------------------------- |
| L1 `domain/**`                            | None — folder doesn't exist yet (TB-006)     |
| L2 `application/**`                       | None — folder doesn't exist yet (TB-007/008) |
| L3 `infrastructure/**`, `presentation/**` | None                                         |
| L4 `main/**`, `worker/**`                 | None                                         |

This task is pure tooling. Nothing here is Clean Architecture yet — there's no code to layer.

### New or changed ports

None. No domain exists yet.

### Redis keys

None.

### Lua scripts

None.

### Migrations

None.

### Decisions this plan is making (flagged for review, not silently picked)

**Module system: ESM, system-wide — overridden by approval, was originally flagged as CommonJS.**
Every package sets `"type": "module"`. `packages/api` uses `"module": "NodeNext", "moduleResolution": "NodeNext"` — Node's modern, currently-supported resolution mode. `packages/web` was ESM regardless (Vite), so this makes the whole repo one consistent module system rather than a split.

The real cost, accepted knowingly rather than glossed over: NodeNext requires the explicit `.js` extension on relative imports even though the source file is `.ts` — e.g. `import { Hold } from '../domain/entities/Hold.js'`. This is unrelated to Redis or Postgres; it's Node's ESM authoring convention. It applies from TB-006 onward, the first task with cross-file imports. Noting it here once so it isn't rediscovered as a surprise mid-task later.

| Option   | Why not chosen                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------- |
| CommonJS | Fewer edge cases, but the approver wants ESM system-wide over the incremental friction — accepted |

**Tooling configs are ESM too, to match**: `eslint.config.js` and `commitlint.config.js` use `import`/`export default` rather than `require`/`module.exports`, since root `package.json` now carries `"type": "module"` and a bare `.js` there is parsed as ESM.

**pnpm is not installed on this machine yet.** Node 22.20.0 and Corepack 0.34.0 are present. Phase 2 will run `corepack enable && corepack prepare pnpm@9 --activate`, then record the exact resolved version pnpm reports into the root `package.json`'s `packageManager` field — I'm not writing a fabricated exact version number into this plan.

**ESLint flat config (`eslint.config.js`), ESLint run separately from Prettier.** ESLint owns correctness (`@typescript-eslint`, `no-console`, `no-explicit-any`, `no-non-null-assertion` — each called out by name in `CLAUDE.md` as banned). Prettier owns formatting and runs independently via `lint-staged`, not through an ESLint-Prettier bridge plugin. Standard, low-friction split.

**Coverage thresholds are configured now but not enforced in the default `pnpm test:unit` run.** `CLAUDE.md`'s gates (`domain/**`/`application/**` 90%, `infrastructure/**` 70%, global 80%) go into `vitest.unit.config.ts`'s `coverage.thresholds`, scoped by path glob, so they're already correct the moment real source files land — retrofitting this later is exactly the kind of pain TB-001 exists to avoid. But they only bite when someone runs with `--coverage`; the plain `pnpm test:unit` stays fast and uninstrumented, matching TB-008's later acceptance line ("`pnpm test:unit` finishes in under 2 seconds") and this task's own "pass on an empty suite" requirement — turning on coverage against an almost-empty tree is a needless way to risk that acceptance criterion for no benefit yet.

**`autocannon` added as a `packages/api` dev dependency now**, per your request to wire up what `docs/BENCHMARKS.md` will need. It's an installed CLI tool with nothing to configure yet — first real use is TB-013's load test — so adding it now carries no half-finished-script risk.

---

## 4. Files

| File                                        | New / Changed | Why                                                                                                                                      |
| ------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                       | New           | Declares `packages/*` as workspace members                                                                                               |
| `package.json` (root)                       | New           | Workspace root: `lint`, `typecheck`, `test:unit`, `test:integration`, `format`, `prepare` scripts; devDependencies; `packageManager` pin |
| `.npmrc`                                    | New           | `engine-strict=true` so a wrong Node/pnpm version fails loudly instead of silently misbehaving                                           |
| `tsconfig.base.json`                        | New           | Shared strict compiler options: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`                 |
| `eslint.config.js`                          | New           | Flat config: `@typescript-eslint` strict rules, `no-console`, `no-explicit-any`, `no-non-null-assertion`, `eslint-config-prettier`       |
| `.prettierrc.json`                          | New           | Minimal formatting config                                                                                                                |
| `.prettierignore`                           | New           | Excludes `pnpm-lock.yaml`, `coverage`, `dist`                                                                                            |
| `commitlint.config.js`                      | New           | ESM, `@commitlint/config-conventional`                                                                                                   |
| `.husky/pre-commit`                         | New           | Runs `lint-staged`                                                                                                                       |
| `.husky/commit-msg`                         | New           | Runs `commitlint --edit`                                                                                                                 |
| `packages/api/package.json`                 | New           | Name `@ticketbox/api`, `"type": "module"`, scripts: `typecheck`, `test:unit`, `test:integration`                                         |
| `packages/api/tsconfig.json`                | New           | Extends `tsconfig.base.json`, `NodeNext`/`NodeNext` module + resolution                                                                  |
| `packages/api/vitest.unit.config.ts`        | New           | `test.include` → `test/unit/**/*.test.ts`; coverage thresholds per `CLAUDE.md`, not run by default                                       |
| `packages/api/vitest.integration.config.ts` | New           | Separate config + setup file per `docs/01` §4.1; `test.include` → `test/integration/**/*.test.ts`; no tests yet                          |
| `packages/api/test/unit/example.test.ts`    | New           | The one trivial test the task's **Tests** line asks for                                                                                  |
| `packages/api/test/integration/.gitkeep`    | New           | Holds the empty directory until TB-010                                                                                                   |
| `packages/web/package.json`                 | New           | Name `@ticketbox/web`, `"type": "module"`, minimal — no Vite/React yet (TB-014)                                                          |
| `packages/web/tsconfig.json`                | New           | Extends `tsconfig.base.json`, bundler resolution                                                                                         |
| `docs/BENCHMARKS.md`                        | Changed       | Fill in **Machine** and **Date started** with real, observed values only                                                                 |

Anything not in this table is out of scope for this PR.

---

## 5. Test plan

| Level       | Test                                                                | What it would catch                                                |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Unit        | `example.test.ts` — "the test runner completes a trivial assertion" | The Vitest unit config, TS transform, and script wiring are broken |
| Integration | none (config only, `--passWithNoTests`)                             | N/A — no adapters exist yet                                        |
| Concurrency | N/A                                                                 | No inventory logic exists yet                                      |
| Smoke       | N/A — TB-013                                                        | —                                                                  |
| E2E         | N/A — TB-016                                                        | —                                                                  |

**Concurrency:** does this task touch inventory? No — pure tooling, no domain code.

**How each test will be proven able to fail:** temporarily break `example.test.ts`'s assertion (`expect(1 + 1).toBe(3)`), confirm `pnpm test:unit` exits non-zero, then restore it. Separately, temporarily introduce `const x: any = 1;` and confirm `pnpm lint` fails on `no-explicit-any`, then revert — proves the banned-construct rules are actually wired, not just declared.

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A — no Redis client exists in this task.
- **What if a key is evicted under `allkeys-lru`?** N/A — no Redis usage yet.
- **What if this operation runs twice?** `pnpm install` and `pnpm migrate`-style setup commands are idempotent by nature of the tools; nothing here is a stateful operation that can double-apply.
- **What if it dies halfway through?** A partially-scaffolded repo is safe to re-run — every file here is either fully overwritten or additive; no migration-style ordering dependency exists at this stage.

---

## 7. Could Postgres already do this?

N/A — this task adds no Redis capability.

---

## 8. Open questions

None blocking. One judgment call is flagged above (CommonJS vs ESM) for the approver to override if a different call is preferred — implementation proceeds with CommonJS unless told otherwise.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed. CommonJS-vs-ESM is recorded in §3 above; it's a tooling default, not a Redis/Postgres architecture decision, so it doesn't meet the ADR bar in `CLAUDE.md` (§6.12 examples are all Redis/Postgres mechanism choices). Flagging here in case the approver disagrees.
- ☑ Task doc — `docs/tasks/TB-001-repository-scaffold.md` — always
- ☐ Benchmark entry — no optimization measured in this task; only the Machine/Date-started housekeeping fields are touched, not a new BENCHMARKS.md section
- ☐ NOTES entry — not a SPIKE task
