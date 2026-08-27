# AI Instructions for Ticketbox

Ticketbox is a tiny box office. It sells tickets to events, and it holds your tickets for 120 seconds while you check out.

**Postgres remembers. Redis coordinates.** Every design decision in this repo is a variation on that sentence.

This is a **learning project**, not a product. Nothing is deployed. The goal is to understand Redis and Postgres properly — where the line between them sits and why. Code that works but teaches nothing has failed.

## The two documents that govern this repo

| Document                                                                                           | What it decides                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [docs/01-tech-lead-architecture-and-standards.md](docs/01-tech-lead-architecture-and-standards.md) | Architecture, layers, testing strategy, code standards, Redis/Postgres mechanics    |
| [docs/02-product-delivery-plan.md](docs/02-product-delivery-plan.md)                               | What to build, in what order, as 42 PR-sized tasks (TB-001…TB-042) across 10 stages |

**These two documents outrank this file.** If anything here contradicts them, they win and this file is the bug. Read Part 1 and Part 2 of the handbook before touching code.

---

## Prime Directive: NEVER ASSUME

If anything is missing, ambiguous, contradictory, or unclear:

1. **Stop immediately**
2. **Ask targeted questions** before acting
3. **Do not guess, invent, or fabricate**

Never invent a Redis command's semantics, a Postgres locking behaviour, or an `ioredis` API from memory. This project is _about_ those semantics — getting one subtly wrong defeats the entire point. Check the docs, or say you're unsure.

---

## Karpathy Guidelines — Anti-Slop Rules

The full skill lives at [.claude/skills/karpathy-guidelines/SKILL.md](.claude/skills/karpathy-guidelines/SKILL.md). The short version applies to every task:

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, **ask**.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so and push back.

### 2. Simplicity First

- Write the minimum code that solves the problem. Nothing speculative.
- No features beyond what the task's **Scope** line asks for.
- No abstractions for single-use code. No configurability nobody requested.
- If 200 lines could be 50, rewrite it.

### 3. Surgical Changes

- Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code or formatting that wasn't part of the request.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, **mention it — don't delete it**.

### 4. Goal-Driven Execution

- Define success criteria before starting. Loop until verified.
- "Fix the bug" → "Write a test that reproduces it, then make it pass."

---

## Codebase-First Behavior

- **Inspect the repository before answering.** Find how a similar thing was already done and align with it.
- **Cite exact file paths and symbols** you rely on (e.g. `src/infrastructure/redis/RedisHoldStore.ts#reserve`).
- The folder structure in handbook §2.4 is **fixed**. Do not invent new top-level directories.
- **Never assume a dependency exists** unless you've seen it in `package.json`.

---

## THE WORKFLOW — mandatory, in order, no phase skipped

**Every task follows these five phases. This is not a suggestion and it is not a default that a busy moment overrides.** It applies to the user and to any coding agent working in this repo.

```
1. PLANNING  ──►  write the plan  ──►  ⛔ WAIT FOR HUMAN APPROVAL ⛔
                                              │
2. CODING    ◄────────────────────────────────┘
                  implement the approved plan, nothing else
                        │
3. CODE REVIEW ────────►  engineering-code-reviewer
                        │  findings fixed, then re-reviewed
                        ▼
4. TESTS     ──►  build the test levels the delivery plan demands
                        │
                        ▼
5. DOCUMENTATION ──►  update the plan · write docs/tasks/TB-NNN-*.md
```

Phases do not run in parallel and they do not run out of order. Writing tests before the code review has been acted on, or writing code before a plan is approved, is a workflow violation — stop and go back.

### Phase 1 — Planning

Read the task in `docs/02-product-delivery-plan.md`, then write a plan to **`docs/implementation-plans/TB-NNN-short-slug.md`** using [`docs/implementation-plans/0000-template.md`](docs/implementation-plans/0000-template.md).

The plan restates, verbatim:

1. **Task ID and title**
2. **Scope** — verbatim from the plan. This is the boundary; do not exceed it.
3. **Dependencies** — confirm the tasks it "needs" are actually merged.
4. **Acceptance** — the concrete condition the plan says must hold.
5. **Tests** — which level(s) the plan requires (unit / integration / smoke / E2E).

and then adds the approach: layers touched, ports added or changed, Redis keys, Lua contracts, migrations, the file list, the test plan, the four failure-mode answers, and "Could Postgres already do this?".

> **⛔ STOP HERE.** Present the plan and **wait for a human to approve it.** Do not begin coding, do not create files, do not "start on the easy part while you're reading". The plan's Status field must read **Approved** with a name in it before Phase 2 begins.
>
> A plan with unresolved blocking questions cannot be approved — resolve them first.

Use `engineering-backend-architect` for the design content when the task has a real design question in it.

### Phase 2 — Coding

Implement **the approved plan**. Not more, not differently.

- Every changed line traces to the plan's file list and the task's Scope line
- A file the plan didn't list is a **plan change** — say so and get agreement rather than widening the diff quietly
- If implementation reveals the plan was wrong, stop and amend the plan. Discovering a plan is wrong is a normal outcome; silently diverging from it is not

Agents: `engineering-senior-developer` for `packages/api`, `engineering-frontend-developer` for `packages/web`, `engineering-devops-automator` for compose and CI.

### Phase 3 — Code review

Run **`engineering-code-reviewer`** on the diff. It reviews at the service level — correctness and race conditions, SOLID compliance, DRY, complexity, readability — plus a Karpathy anti-slop pass and this repo's mechanical rules (layer boundaries, literal Redis keys, inline Lua, `any`, `!`, `console.log`).

It never compliments code. Its output is Critical Issues, Major Improvements, a merge verdict, and a **For the Test Phase** block naming behaviours Phase 4 must cover.

**Fix every Critical Issue, then re-run the review.** Phase 4 does not start on a NEEDS WORK verdict. Findings you deliberately don't fix get recorded in the task doc with the reason.

Add `engineering-security-engineer` for anything on the write path.

### Phase 4 — Tests

Now build the tests the delivery plan's **Tests** line demands, plus the behaviours the code review's "For the Test Phase" block named.

- Every level the plan lists — not a subset you found convenient
- Every Lua script gets an integration test. Non-negotiable
- Every inventory path gets a concurrency test asserting an **exact** final count
- **Break the implementation and watch each new test go red** before trusting it

Agents: `testing-api-tester` to write them, `testing-test-results-analyzer` at a stage boundary, `testing-performance-benchmarker` if anything measurable changed.

### Phase 5 — Documentation

1. **Update the implementation plan** — mark it done, and record where reality diverged from it
2. **Write `docs/tasks/TB-NNN-short-slug.md`** from [`docs/tasks/0000-template.md`](docs/tasks/0000-template.md) — what was delivered, how it works, where it diverged from the plan, tests shipped, code review outcome, failure modes as built
3. **ADR** if a real decision was made
4. **BENCHMARKS entry** if anything was measured

`engineering-technical-writer` owns this phase.

### Then, and only then

```
One task = one branch = one PR = one squash merge
feat/TB-022-lua-create-hold
```

**A task is not done** until all five phases are complete, CI is green, _and_ the tests the plan lists exist and pass. Not "should pass" — pass, with output you have actually seen.

Run `testing-reality-checker` before the merge. It defaults to NEEDS WORK and verifies against the Acceptance line with commands it runs itself.

### SPIKE tasks are different

Tasks marked **SPIKE** (TB-019a, TB-021, TB-028) are throwaway experiments. **They are not merged.** Their only deliverable is a written entry in [docs/NOTES.md](docs/NOTES.md): what you did, what you expected, what actually happened, what it changed about how you think.

Do not "helpfully" turn a spike into merged code. TB-021's job is to _produce_ a race condition and watch it oversell. Fixing it there destroys the lesson TB-022 exists to teach.

**Their workflow is shortened**: Phase 1 (a short plan — what you'll try and what you expect to happen), Phase 2 (run the experiment), Phase 5 (the NOTES.md write-up). No code review, no tests, no task doc, no merge.

---

## Architecture: the Dependency Rule is absolute

Four layers. Dependencies point **inward only**.

```
L4  Frameworks & Drivers   Fastify · ioredis · pg · React · Docker · Playwright
L3  Interface Adapters     Controllers · DTO mappers · PgEventRepository · RedisHoldStore
L2  Use Cases              CreateHold · ConfirmOrder · ReleaseExpiredHolds · + the PORTS
L1  Entities               Event · TicketTier · Hold · Order · Money · Quantity
```

| Layer | Directory                                               | May import                                                          |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| L1    | `packages/api/src/domain/**`                            | `domain/**` only — **nothing else, ever**                           |
| L2    | `packages/api/src/application/**`                       | `domain/**`, `application/**`. **Never** `ioredis`, `pg`, `fastify` |
| L3    | `packages/api/src/infrastructure/**`, `presentation/**` | inward only — **never each other**                                  |
| L4    | `packages/api/src/main/**`, `worker/**`                 | anything (this is where wiring lives)                               |

**Only `main/composition.ts` may `new` a concrete adapter.** That file is the map of the system; it should read top to bottom.

These boundaries are enforced by ESLint and **fail CI when broken** (TB-009). If you need an exception, you have found a missing port — say so rather than reaching across a layer.

### Hard rules

1. **Ports are named for what the domain needs, not the technology.** `HoldStore`, not `RedisClient`. `EventPublisher`, not `PubSub`. A vendor name in a port name means the abstraction has leaked.
2. **One use case, one public method**, called `execute`. Two methods means two use cases.
3. **Constructor injection only.** No DI container, no service locator, no singletons reached across modules.
4. **Entities are immutable.** Mutations return new instances.
5. **Never call `Date.now()` inside a use case.** Inject the `Clock` port. This project's core concept is a timer — this is not optional.
6. **Expected failures are return values; bugs are exceptions.** "Not enough tickets" → `{ ok: false, reason: 'insufficient' }`. A dead connection → throw.
7. **Controllers contain no business logic.** Validate, map, call one use case, map back. An `if` about the domain in a controller belongs in an entity.
8. **Only simple data crosses boundaries.** DTOs in and out — never a Fastify `Request`, never a `pg` row, never an `ioredis` reply.

---

## Redis rules

9. **All Redis keys come from the key registry** (`infrastructure/redis/keys.ts`). A string-literal key anywhere else is a review rejection.
10. **Every Lua script is a named module** in `scripts/lua/`, with a typed wrapper and an integration test. **Never inline Lua in a method body.**
11. **Every Lua script gets a header comment explaining the race condition it prevents.** That is the highest-value comment in this codebase. Comment the _why_, never the _what_.
12. **Keep scripts short and loop-free.** A Lua script blocks the whole server for its duration — the blocking _is_ the atomicity guarantee. Redis won't kill an over-running script; it replies `BUSY` (`busy-reply-threshold`, default 5000ms).

Traps this project exists to teach — do not fall into them while writing the code that demonstrates them:

- A sequence of commands from the app is **not** atomic, even though each command is. A round trip sits between them.
- `SET k v` (no `EX`) on an existing key **clears its TTL** and silently makes it immortal. `INCR`/`HSET`/`LPUSH` leave the TTL alone.
- Releasing a lock with `DEL` instead of a compare-and-delete script can release someone else's lock.
- Expiry is not a reliably observable event. TTL guarantees _visibility_, not the instant of freeing. Something must still reconcile.
- Under `allkeys-lru`, eviction can delete a lock, a hold, or an inventory counter you rely on for correctness.

**Before adding any Redis feature, ask out loud: "Could Postgres already do this?"** (handbook §7.3). Being able to argue both sides is the actual deliverable. If Postgres is the better answer and we're using Redis anyway to learn it, say so explicitly in the ADR.

---

## TypeScript & code quality

- `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`. **Never weaken `tsconfig.json` to make types pass.**
- **`any` is banned.** Use `unknown` plus narrowing. An `as` cast requires a comment explaining why.
- **No non-null assertions (`!`).** If you know it's non-null, prove it to the compiler.
- **Branded types for IDs**: `type EventId = string & { readonly __brand: 'EventId' }`. This domain is unusually prone to passing a tier ID where an event ID belongs.
- **Explicit return types** on all exported functions and class methods.
- **No unused variables or imports.** Fix them; don't suppress the rule.
- **`console.log` is banned by lint.** Structured logging via `pino`.
- Every request gets a **correlation ID**, propagated into worker messages.
- **Never log** an idempotency key, an email, or a full request body at info level.
- Domain errors are typed classes extending `DomainError`, mapped to HTTP **once**, in a single Fastify error handler. Never `reply.code(409)` scattered through controllers.
- `pnpm lint --max-warnings 0` and `pnpm typecheck` must pass clean before any task is marked done. No blanket `eslint-disable`.

### The UI stays dumb

`packages/web` is deliberately thin, and keeping it thin is a rule, not a preference:

- Vite + React + TypeScript. **No Next.js. No state library. No component library.** `useState`/`useEffect` and one stylesheet.
- **Zero business logic.** The browser never computes availability and never decides whether a hold has expired. If you catch yourself writing `if (remaining < qty)` in React, that rule belongs in an entity.
- **The countdown is display-only.** It counts down from the server's `expiresAt`; at zero it re-fetches. **The server is the authority on time.**
- **Do not add npm packages** to the web package without asking.

---

## Testing

Four levels, distinguished by _what is real and what is faked_.

| Level           | Real                              | Faked           | Speed          | Share             |
| --------------- | --------------------------------- | --------------- | -------------- | ----------------- |
| **Unit**        | your business logic (L1+L2)       | every port      | <2s, no Docker | ~60%              |
| **Integration** | one adapter + one real engine     | everything else | <30s           | ~30%              |
| **Smoke**       | the running system                | nothing         | <10s           | ~6 tests, forever |
| **E2E**         | browser → API → both DBs → worker | nothing         | minutes        | 5 specs           |

```bash
pnpm test:unit          # no docker needed, run on every save
pnpm test:integration   # needs: docker compose up
pnpm test:smoke         # needs: api running
pnpm test:e2e           # needs: full stack
pnpm test:all
```

### Non-negotiables

- **Every Lua script must have an integration test.** A Lua bug is invisible to TypeScript.
- **Concurrency tests are the most valuable tests in this project.** `Promise.all` of 200 simultaneous reserves against a tier with 10 remaining, asserting the exact final count and exactly 10 successes. Write them for every path that touches inventory.
- **A test must be able to fail.** Before trusting a new test, break the implementation and watch it go red. Especially the concurrency ones.
- **Bug fixes start with a failing test** that reproduces the bug. Always.
- **No sleeping.** `await new Promise(r => setTimeout(r, 3000))` is banned in unit and integration tests. Use `FakeClock`, or a deliberately tiny real TTL (~50ms) with polling in the specific tests that must exercise real Redis expiry.
- **No shared mutable state between tests.** Every test builds its own world.
- **Test data via builders**: `aTier().withRemaining(10).build()`.
- **AAA structure**, blank lines between Arrange / Act / Assert.
- **Naming**: `describe('CreateHoldUseCase')` → `it('rejects a hold larger than remaining inventory')`. Behaviour, never implementation. Not `it('calls holdStore.reserve')`.

Integration isolation: Redis **DB index 9** with `FLUSHDB` in `beforeEach`; a dedicated Postgres database with each test in a transaction that rolls back.

If you find yourself with 40 E2E tests, something has gone wrong — a rule that belonged in a unit test has leaked into the UI layer.

---

## Documentation deliverables

Five artefacts. Two of them are produced by the workflow above and are **not optional**.

| Artefact                | When                                                                                                          | Where                                      | Template                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Implementation plan** | **Phase 1 of every task** — approved before coding starts                                                     | `docs/implementation-plans/TB-NNN-slug.md` | [`0000-template.md`](docs/implementation-plans/0000-template.md) |
| **Task doc**            | **Phase 5 of every task** — written after, from what actually happened                                        | `docs/tasks/TB-NNN-slug.md`                | [`0000-template.md`](docs/tasks/0000-template.md)                |
| **ADR** (~1 page)       | every real decision: why Lua over `WATCH`, why cache-aside over write-through, why Streams over `SKIP LOCKED` | `docs/adr/NNNN-title.md`                   | [`0000-template.md`](docs/adr/0000-template.md)                  |
| **Benchmark entry**     | every optimization — measured numbers, reproducible command, before _and_ after                               | [docs/BENCHMARKS.md](docs/BENCHMARKS.md)   | —                                                                |
| **Spike write-up**      | every SPIKE task                                                                                              | [docs/NOTES.md](docs/NOTES.md)             | in-file                                                          |

The plan and the task doc are named after the task and share its slug with the branch, so `feat/TB-022-lua-create-hold` has `implementation-plans/TB-022-lua-create-hold.md` and `tasks/TB-022-lua-create-hold.md`. Three files, one name.

**The most valuable section in the task doc is "Where this diverged from the plan."** Fill it honestly — that gap is where the learning is, and smoothing it over wastes the exercise.

Rules:

- **Measured, not estimated.** A BENCHMARKS row without a command that reproduces it is worthless. Never write a number you did not observe.
- ADRs are the most valuable artefact here — in six months they're what actually gets reread. Write the alternative you rejected and _why_, not just the choice.
- Diagrams are welcome where they clarify a race condition, a layer trace, or a message flow. Use Mermaid. They are **not** mandated per response — a diagram that restates the code adds noise.
- Update `README.md` and the delivery plan's progress tracker when a stage completes.

---

## Commits & PRs

- **Conventional Commits**: `feat(holds): add Lua-backed reserve`. Enforced by commitlint.
- Branch `feat/TB-0NN-short-slug`. Squash merge.
- PR description states: **what**, **why**, **which tests were added**, **which task ID it closes**, and links **the approved implementation plan** and **the task doc** — [`.github/pull_request_template.md`](.github/pull_request_template.md) pre-fills this and turns the five phases into a checklist.
- **CI must be green to merge. No exceptions.**
- **All five workflow phases complete.** A PR without an approved plan, a clean code review, and a task doc is not ready, whatever CI says.

CI order (GitHub Actions, every PR):
`typecheck → lint → test:unit → build → docker compose up → migrate + seed → test:integration → test:smoke → test:e2e`

Coverage gates — a floor, not a goal:

| Path                          | Line coverage                               |
| ----------------------------- | ------------------------------------------- |
| `domain/**`, `application/**` | **90%** — these are pure, there's no excuse |
| `infrastructure/**`           | 70%                                         |
| Global                        | 80% — CI fails below                        |

A 100%-covered use case with no concurrency test is not tested.

---

## Reference Impact Analysis — before ANY rename or value change

Mandatory before renaming a symbol, a **Redis key**, a **Lua script name**, a DB column, an env var, or a DTO field.

1. **Search the whole repo first:**
   ```bash
   grep -rn "oldName" . --include="*.ts" --include="*.tsx" --include="*.lua" \
     --include="*.sql" --include="*.json" --include="*.md" --include="*.yml" \
     --include="*.yaml" --include="docker-compose.yml"
   ```
2. **Categorise every hit**: source · tests · fakes · Lua scripts · migrations & seed · docs (`/docs`, ADRs, README, this file) · compose & CI · `.env.example`.
3. **Update every reference.** No stale hits anywhere.
4. **Re-run the grep** and confirm zero remaining hits.
5. **Assess risk before acting:**
   - Renaming a **Redis key** invalidates live keys and orphans in-flight holds — say what happens to keys already in Redis.
   - Changing a **DB column** needs a new numbered migration. Never edit a migration that has already run.
   - Changing a **DTO field** is a breaking API change — `packages/api` and `packages/web` must move in the same PR.
6. **Never mark the task done** until the grep is clean.

---

## Subagents

Twelve agents in [.claude/agents/](.claude/agents/), each written for this stack and this delivery plan. Invoke them explicitly; they are not automatic.

**Mapped onto the workflow:**

| Phase               | Agent                             | Role                                                                                                                |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 · Planning        | `engineering-backend-architect`   | Port design, Redis/Postgres split, key registry, Lua contracts, schema, ADR content                                 |
| 2 · Coding          | `engineering-senior-developer`    | `packages/api` — entities, use cases, adapters, wiring                                                              |
| 2 · Coding          | `engineering-frontend-developer`  | `packages/web` — screens, countdown, SSE, typed client                                                              |
| 2 · Coding          | `engineering-devops-automator`    | Docker Compose, migration runner, GitHub Actions, TB-040 ops experiments                                            |
| **3 · Code review** | **`engineering-code-reviewer`**   | **The Phase 3 gate. Correctness, SOLID, DRY, complexity, readability + Karpathy anti-slop. Never compliments code** |
| 3 · Code review     | `engineering-security-engineer`   | Write-path abuse, idempotency, locking, rate limiting, log hygiene                                                  |
| 4 · Tests           | `testing-api-tester`              | Integration tests, the six smoke tests, concurrency tests                                                           |
| 4 · Tests           | `testing-test-results-analyzer`   | Pyramid ratios, coverage gates, flake, missing concurrency coverage                                                 |
| 4 · Tests           | `testing-performance-benchmarker` | Before/after measurement for BENCHMARKS.md                                                                          |
| 5 · Documentation   | `engineering-technical-writer`    | Implementation plan updates, task docs, ADRs, BENCHMARKS, NOTES                                                     |
| Before merge        | `testing-reality-checker`         | Defaults to NEEDS WORK, verifies against the Acceptance line with commands it runs itself                           |
| All phases          | `agents-orchestrator`             | Drives one TB task through all five phases and enforces the gates                                                   |

Three things every one of them enforces: **the task's Scope line is the boundary**, **a task is done when its tests have been observed passing** — not when they should pass — and **no phase is skipped**.

**Skills** in [.claude/skills/](.claude/skills/): `karpathy-guidelines` (anti-slop coding behaviour) and `ai-slop-detector` (auditing AI-generated code quality).

---

## Local commands

```bash
./scripts/dev-up.sh        # postgres:16 · redis:7 · redisinsight — one command, verifies all three
# Windows: .\scripts\dev-up.ps1
# or, the primitive underneath: docker compose up -d --wait

pnpm install
pnpm migrate               # idempotent
pnpm seed                  # 3 events, 3 tiers each, one deliberately sold out

pnpm dev:api               # http://localhost:3000
pnpm dev:worker            # stream consumer
pnpm dev:web               # http://localhost:5173
```

RedisInsight at `http://localhost:5540` — use it to inspect keys and TTLs directly rather than guessing what Redis holds.

---

## Notes & best practices

1. **Mirror the existing design exactly.** Don't invent new patterns — suggest improvements and ask before implementing them.
2. **If multiple solutions exist, ask** before choosing.
3. **When unsure about layering, key naming, or a Redis/Postgres semantic — ASK FIRST.**
4. **Optimize for readability and for the reader six months from now.**
5. **Never mark something done that you haven't run.** If tests fail, say so and paste the output. If a step was skipped, say which and why.
6. **Every code change should reduce or maintain tech debt.** If a shortcut is unavoidable, leave `// TODO(tech-debt):` with what needs fixing and why.

### Major refactors

For any change touching multiple layers or packages: **pause and present** the proposed change, the reason, pros and cons, and the impact (API contract, data migration, Redis key format). **Wait for confirmation.** Do not implement large refactors without explicit approval.

---

**This repository prioritises understanding over speed.** Take the time to understand the mechanics before implementing. A feature that works but whose failure mode you can't explain is not finished.
