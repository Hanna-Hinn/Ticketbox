# TB-009 — Architecture boundary enforcement

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-009 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-009-boundary-enforcement` (stacked on `feat/TB-008-use-cases-and-fakes`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`): `domain/**` imports only `domain/**`; `application/**` may not import `ioredis`, `pg`, `fastify`; only `main/composition.ts` may import concrete adapters.

**Acceptance:** adding `import Redis from 'ioredis'` to a use case fails lint. **Try it, watch it fail, then revert** — an unverified rule isn't a rule.

**Tests:** none; the linter is the test.

**Depends on:** TB-008 (open, PR #11 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

The Dependency Rule, which three tasks have so far checked by eye and by grep, becomes a CI failure. One file changes: `eslint.config.js` gains per-directory `no-restricted-imports` overrides. No new dependency, no new directory, no application code.

The Acceptance line is explicit that the rule must be seen failing before it counts. Every rule this plan adds gets the same treatment: a violating import, a red lint run, a revert.

---

## 3. Approach

### Layers touched

None — tooling only.

### The rules

Built-in `no-restricted-imports` with gitignore-style `patterns` groups, one override block per directory, in the existing flat config. Import specifiers are matched as strings, so relative paths are matched by their text (`../../infrastructure/…`), not by what they resolve to.

| Files                                                 | May not import                                                                                              | Enforces                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/domain/**`                                       | anything that is not `./…` or `../…`, and `../../…` (which leaves `domain/`)                                | "imports nothing" — not Zod, not `node:*`, not L2+ |
| `src/application/**`                                  | `ioredis`, `pg`, `fastify` (and their subpaths); `**/infrastructure/**`, `**/presentation/**`, `**/main/**` | L2 imports only L1 and L2                          |
| `src/infrastructure/**`                               | `**/presentation/**`, `**/main/**`                                                                          | L3 imports inward, never sideways                  |
| `src/presentation/**`                                 | `**/infrastructure/**`, `**/main/**`                                                                        | L3 imports inward, never sideways                  |
| `src/main/**`, `src/worker/**` except the three below | `**/infrastructure/**`, `**/presentation/**`                                                                | only the composition root wires adapters           |

### Decisions this plan is making

1. **Built-in `no-restricted-imports`, not `eslint-plugin-boundaries`.** The Scope line allows either. The built-in rule needs no dependency and no element-type configuration, and the five blocks above are readable in one screen. The cost is that it matches specifier _strings_, so a relative import that reaches another layer through an alias or a barrel would not be caught — there are no aliases and no barrels in this repo (TB-007 decision 6 rejected barrels for exactly this kind of reason). If that ever changes, this decision should be revisited.
2. **`domain/**` is restricted by shape, not by list.** "May import only `domain/**`" is expressed as: the specifier must start with `./` or `../` and must not start with `../../`. Every domain file sits at depth two (`domain/<kind>/File.ts`), so `../` stays inside `domain/` and `../../` leaves it. A `node:` builtin or a package name has no leading dot and is rejected. This is the strictest rule in the file and the one the handbook cares about most ("Not Zod, not a date library, nothing").
3. **`main/composition.ts`, `main/migrate.ts` and `main/seed.ts` are the named exceptions to "only the composition root imports adapters".** The two scripts are TB-004's CLI entry points: each is its own tiny composition root for one `pg.Client` and one L3 function, and they predate this rule. Listing them by name keeps the rule honest — a fourth file in `main/` that imports an adapter fails lint and has to argue its way onto this list.
4. **Tests are not restricted.** `test/**` imports `src/**` and `test/fakes/**` freely; a unit test importing `pg` would be a design smell but is not the Dependency Rule, and the handbook's levels already define what a unit test may touch.
5. **Type-aware linting (`projectService`) reconsidered and not enabled.** The existing comment named TB-009 as the point to reconsider it; type-aware rules do not help enforce import boundaries, which is all this task is about. The comment is rewritten to be true today (its premise — "domain/ and application/ still empty" — no longer is) rather than appended to.
6. **`application/` is restricted by shape, like `domain/`** _(changed after the Phase 3 review)_. The first draft banned three package names (`ioredis`, `pg`, `fastify`) — the Scope line's parenthetical — and let `node:crypto` and `zod` into a use case. `randomUUID()` in a use case is the exact thing the `TokenGenerator` port exists to prevent. The Scope's list is a minimum; the rule the plan's table promised is "L1 and L2 only", so the specifier-shape regex is reused and the driver list goes.
7. **The domain rule also names the outer layers** _(review)_. The depth assumption ("every domain file sits at `domain/<kind>/`") was not enforced: a `domain/x.ts` importing `../application/…` passed, and so did `./../../application/…` from an entity (starts with `./`, does not start with `../../`). Listing `**/application/**` etc. closes both; the `../../` regex stays because it is the only thing that catches a relative reach to something outside the named layers.
8. **Dynamic `import()` and `typeof import()` are banned under `src/`** _(review)_. `no-restricted-imports` only visits static import/export declarations, so `(await import("ioredis"))` in a use case passed every block. Nothing here has a reason to lazy-load — wiring is static in the composition root — so one `no-restricted-syntax` block closes the hole outright.
9. **`**/test/**` is forbidden from every `src/` layer** _(review)_. Tests may import `src/`; `src/` importing a fake is a breach in the other direction that nothing else would stop.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File               | New / Changed | Why                                     |
| ------------------ | ------------- | --------------------------------------- |
| `eslint.config.js` | Changed       | The five `no-restricted-imports` blocks |

---

## 5. Test plan

**Tests:** none — the linter is the test. What stands in for them, each **observed** red then reverted (output goes in the task doc):

| Violation                                                                      | Expected                                | What it would catch                    |
| ------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------- |
| `import Redis from "ioredis"` in `application/use-cases/CreateHold.ts`         | lint fails naming the file and the rule | the literal Acceptance line            |
| `import { z } from "zod"` in `domain/value-objects/Money.ts`                   | lint fails                              | a package sneaking into L1             |
| `import … from "../../application/ports/Clock.js"` in a domain entity          | lint fails                              | L1 reaching outward through a relative |
| `import … from "../../presentation/x.js"` in `infrastructure/postgres/seed.ts` | lint fails                              | the sideways L3 import                 |
| `import … from "../infrastructure/postgres/seed.js"` in a new `main/other.ts`  | lint fails                              | an adapter wired outside the root      |
| the real tree as it stands (incl. `main/migrate.ts` → `infrastructure/`)       | lint passes                             | the rule being too strict for TB-004   |

**Concurrency:** N/A.

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A — lint.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Lint is idempotent.
- **What if it dies halfway through?** N/A.
- **The real risk:** a rule that passes because it matches nothing. Mitigated by §5 — every block is seen red at least once before this PR is done.

---

## 7. Could Postgres already do this?

N/A.

---

## 8. Open questions

None blocking. Decision 3 (naming `migrate.ts`/`seed.ts` as exceptions) is the one a reviewer might want done differently — e.g. moving those scripts out of `main/`. The handbook's folder structure puts entry points in `main/`, so they stay.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-009-boundary-enforcement.md`, with the red output of each trial violation
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
