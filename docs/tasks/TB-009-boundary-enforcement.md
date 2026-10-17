# TB-009 — Architecture boundary enforcement

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-009 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-009-boundary-enforcement.md`](../implementation-plans/TB-009-boundary-enforcement.md)
**Branch / PR:** `feat/TB-009-boundary-enforcement` · [#12](https://github.com/Hanna-Hinn/Ticketbox/pull/12) (based on #11)
**ADR:** none.

---

## What this task delivered

The Dependency Rule is now a lint failure, and therefore (via TB-005) a blocked merge. `eslint.config.js` encodes the CLAUDE.md layer table with the built-in `no-restricted-imports` rule, one block per directory, plus a `no-restricted-syntax` ban on dynamic `import()` so nothing can route around the blocks. Every rule was seen red on a deliberate violation before it was trusted; thirteen of them are below. This closes Stage 1.

---

## How it works

```
src/**              no dynamic import(), no typeof import()      ← no-restricted-imports never sees them
src/domain/**       specifier must start with ./ or ../ ; ../../ leaves domain/ ;
                    and application/ infrastructure/ presentation/ main/ worker/ test/ by name
src/application/**  specifier must start with ./ or ../ (so no package, no builtin — ioredis, pg,
                    fastify, node:crypto, zod alike); never infrastructure/ presentation/ main/ worker/ test/
src/infrastructure/** never presentation/ main/ worker/ test/
src/presentation/**   never infrastructure/ main/ worker/ test/
src/main/**, src/worker/**  never infrastructure/ or presentation/
                    except main/composition.ts, main/migrate.ts, main/seed.ts
```

Specifiers are matched as _strings_. That works because the repo has no path aliases and no barrels, and is now a reason never to add them: an alias would resolve to a layer the string does not name. The relative-import groups (`**/application/**`) match `../../application/x` and `./../../application/x` alike because ESLint builds its matcher with `allowRelativePaths`.

### Layers touched

None — tooling.

### Key files

| File               | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `eslint.config.js` | `anyPackageOrBuiltin` regex; `forbid(files, patterns, { except })`; six blocks |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                | What actually happened                                                                                                                                                                                                                                                          | Why                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `application/` bans `ioredis`, `pg`, `fastify` — the Scope line's list | **Bans every package and builtin**, by the same specifier-shape regex `domain/` uses. The first draft let `import { randomUUID } from "node:crypto"` and `import { z } from "zod"` into a use case — the former being exactly what the `TokenGenerator` port exists to prevent. | Review, Major: the plan's own table promised "L2 imports only L1 and L2"; the Scope's three names are a minimum, not the rule. |
| `domain/` restricted by shape only (`./`, `../`, not `../../`)         | Also names the outer layers. Two bypasses passed the shape rule: a depth-1 `domain/x.ts` importing `../application/…`, and `./../../application/…` from an entity (starts with `./`, does not start with `../../`, resolves to the same file).                                  | Review, Major: the depth assumption in the comment was not enforced by anything.                                               |
| No mention of dynamic imports                                          | `no-restricted-syntax` bans `ImportExpression` and `TSImportType` under `src/`. `no-restricted-imports` only visits static import/export declarations; `(await import("ioredis"))` in a use case passed every block.                                                            | Review, Major. Wiring is static in the composition root, so an outright ban costs nothing.                                     |
| Tests unrestricted, nothing said about the reverse direction           | `**/test/**` is forbidden from every `src/` layer. A use case importing `test/fakes/FakeClock.js` passed.                                                                                                                                                                       | Review: a fake wired from production code is a breach in the other direction.                                                  |
| Decision 5: leave the `projectService` comment "as it is"              | Rewritten to be true today. The first commit _appended_ "TB-009 reconsidered it" under a premise ("domain/ … still empty") that is false now — a changelog entry in a comment.                                                                                                  | Review, Minor.                                                                                                                 |
| `forbid(files, patterns, ignores)`                                     | `forbid(files, patterns, { except })` — the exemption names itself at the call site.                                                                                                                                                                                            | Review, Minor: a third positional array does not announce "these files are exempt".                                            |

---

## 4. Tests shipped

None — "the linter is the test". What stands in: the real tree passes, and thirteen trial violations fail. Each trial was a one-line edit (or one new file), linted, then reverted; `git status` was clean after.

```
===== REAL TREE =====
$ pnpm lint --max-warnings 0
exit code: 0        (including main/migrate.ts and main/seed.ts → infrastructure/, exempted by name)

 1 ioredis in a use case (Acceptance line)
   CreateHold.ts 1:1  'ioredis' import is restricted … application/ never imports a package or a builtin — not ioredis, pg, fastify, not node:crypto, not zod. Define a port instead
 2 type-only ioredis in a use case
   CreateHold.ts 1:1  'ioredis' import is restricted … (same)                       ← allowTypeImports is off
 3 node:crypto in a use case
   CreateHold.ts 1:1  'node:crypto' import is restricted … (same)                   ← the TokenGenerator rule, mechanical
 4 zod in domain
   Money.ts 1:1       'zod' import is restricted … domain/ imports nothing outside domain/ — not a package, not a builtin
 5 depth-1 domain file reaching application
   domain/depth1.ts   '../application/ports/Clock.js' import is restricted … domain/ imports nothing outside domain/
 6 ./../../ bypass from a domain entity
   Hold.ts 1:1        './../../application/ports/Clock.js' import is restricted … domain/ imports nothing outside domain/
 7 dynamic import() in a use case
   CreateHold.ts 1:24 No dynamic import(): it bypasses the boundary lint            no-restricted-syntax
 8 infrastructure importing presentation
   seed.ts 1:1        '../../presentation/http/server.js' import is restricted … infrastructure/ imports inward only
 9 presentation importing infrastructure
   presentation/http/x.ts  '../../infrastructure/postgres/seed.js' import is restricted … presentation/ imports inward only
10 application importing an adapter
   GetEventAvailability.ts '../../infrastructure/postgres/seed.js' import is restricted … application/ imports domain/ and application/ only
11 a fourth main/ file importing an adapter
   main/other.ts      '../infrastructure/postgres/seed.js' import is restricted … Only main/composition.ts may import a concrete adapter
12 worker/ importing an adapter
   worker/x.ts        '../infrastructure/postgres/seed.js' import is restricted … Only main/composition.ts may import a concrete adapter
13 application importing a test fake
   CreateHold.ts 1:1  '../../../test/fakes/FakeClock.js' import is restricted … application/ imports domain/ and application/ only
```

The reviewer independently reproduced all of these plus `export { default } from "ioredis"`, `typeof import("ioredis")`, a depth-3 domain reach, and `infrastructure/` → `test/`, and confirmed the three directions that must stay _silent_: `infrastructure/redis` → `infrastructure/postgres`, `presentation/` → `application/`, `infrastructure/` → `application/`.

**Coverage after this task:** unchanged — no runtime code.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It read the rule's source to learn which AST nodes it visits, then linted eighteen throwaway files against the config.
**Verdict:** NEEDS WORK → fixed → re-reviewed (fourteen trials re-run against the committed config) → **SAFE TO MERGE**

| Finding                                                                                   | Severity | Resolution                                                    |
| ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `application/` let `node:crypto` and `zod` through; config comment and plan promised more | Major    | Shape regex, same as `domain/`                                |
| `domain/` depth assumption unenforced; `./../../` spelling bypassed the `../../` regex    | Major    | Named-layer group added; regex kept                           |
| Dynamic `import()` / `typeof import()` bypass every block                                 | Major    | `no-restricted-syntax` under `src/`                           |
| Depth-3 domain false positive with a misleading message                                   | Minor    | Message now says what it tests                                |
| Positional `ignores` in the helper                                                        | Minor    | `{ except }`                                                  |
| Changelog-style comment append                                                            | Minor    | Comment rewritten                                             |
| Comment cited handbook §2.3 instead of the "Boundaries" block                             | Minor    | Fixed                                                         |
| L3 messages did not name `test/` after it joined the group                                | Minor    | Fixed in Phase 5                                              |
| `worker/**` globs reference a directory that does not exist                               | Noted    | Kept — §2.4 lists `worker/`; trial 12 proves the glob is real |
| Cross-adapter imports inside `infrastructure/` are allowed                                | Noted    | Not in Scope; no document forbids it; left                    |

Findings deliberately **not** fixed: the last two rows.

---

## 6. Failure modes, as built

- **Redis down / key evicted / runs twice / dies halfway:** N/A — lint.
- **The failure mode that matters here:** a rule that passes because it matches nothing. Every block above has been seen red at least once (§4). The rule that _would_ still pass silently: an import through a path alias or a barrel, because specifiers are matched as strings. Neither exists; adding one is a decision to revisit this config.

---

## 7. What I'd do differently

Enumerate bypasses before claiming enforcement. The first draft's `application/` block implemented the Scope line's parenthetical instead of the rule the plan's own table stated, and I did not try `node:crypto` because I had not listed "what would a developer actually reach for?" before writing the trials. The reviewer did.

---

## 8. Follow-ups left behind

- [ ] `packages/web` has no lint rules yet. The task that adds its ESLint config should decide whether `web/` may import `api/src/domain` types (TB-015 shares DTO types — that is the moment).
- [ ] If a path alias or a barrel is ever introduced, this string-matching config stops being sufficient and `eslint-plugin-boundaries` (resolution-based) becomes the right tool.
