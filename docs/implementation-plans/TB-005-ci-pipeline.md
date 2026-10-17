# TB-005 — CI pipeline

**Status:** Implemented — see [`docs/tasks/TB-005-ci-pipeline.md`](../tasks/TB-005-ci-pipeline.md); decision 4 was wrong about _which_ branches the protection must target (see the task doc)
**Date:** 2026-10-17
**Task:** TB-005 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-005-ci-pipeline` (stacked on `feat/TB-004-migrations-and-seed`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** GitHub Actions: `typecheck → lint → test:unit → build`, plus a job that spins up compose, migrates, seeds, and runs `test:integration`. Branch protection requiring green CI.

**Acceptance:** a PR with a lint error cannot merge.

**Tests:** none new; this task runs the existing ones.

**Depends on:** TB-001 (merged, PR #2), TB-004 (open, PR #7 — this branch is stacked on it) — confirmed: ☑ TB-001 merged, ☑ TB-004 is the base of this branch

---

## 2. What I understand this to mean

One workflow file that turns the handbook's quality gates into something that actually blocks a merge. Two jobs: a fast one that fails on the first cheap check (typecheck, lint, unit, build, in that order), and a slower one that only runs if the fast one passed, bringing up the compose stack, migrating, seeding, and running the integration suite. Smoke and E2E steps are **not** added yet — there is no API to smoke (TB-013) and no browser test (TB-016); each of those tasks appends its own step.

Branch protection is a repository setting, not a file. It cannot be committed, and it can only name a check that has run at least once. See decision 4.

---

## 3. Approach

### Layers touched

None — `.github/workflows/` and two `package.json` lines. No application code.

### New or changed ports / Redis keys / Lua scripts / migrations

None.

### The workflow

```
.github/workflows/ci.yml
  on: pull_request (any base) · push to main
  concurrency: one run per ref, cancel in progress

  checks  (ubuntu-24.04, node 22, pnpm from packageManager)
    pnpm install --frozen-lockfile
    pnpm typecheck      ─┐
    pnpm lint            │ sequential steps: a lint error costs ~40 s,
    pnpm test:unit       │ not a full integration run
    pnpm build          ─┘

  integration  (needs: checks)
    pnpm install --frozen-lockfile
    docker compose up -d --wait postgres redis      ← not redisinsight; nothing in CI opens it
    pnpm migrate && pnpm seed                        ← the TB-004 acceptance line, in CI, every PR
    pnpm test:integration
    on failure: docker compose logs
```

`pull_request` with no branch filter is deliberate: the stacked PRs in this repo target feature branches, not `main`, and they must run CI too.

### Decisions this plan is making

1. **Two jobs, not one.** The Scope line reads as two things ("…`build`, plus a job that…"). The split also makes the fast feedback visible as its own check and keeps Docker out of the path of a lint failure.
2. **`pnpm build` is a root script running `pnpm -r --if-present run build`, and today no package has a `build` script.** The step is wired now because the Scope line names it and the handbook's CI order includes it; it starts doing work when TB-014 adds `vite build` to `packages/web`. `packages/api` runs through `tsx` and nothing is deployed, so it gets no build script. This is the one step that is currently a no-op, and it is stated here so nobody mistakes it for a check that tested something.
3. **Versions pinned:** `ubuntu-24.04` (not `ubuntu-latest`), Node `22`, pnpm from the `packageManager` field (`pnpm/action-setup@v4` reads it), `actions/checkout@v4`, `actions/setup-node@v4`. The devops agent brief is explicit: "latest" is how a reproducible stack stops being reproducible.
4. **Branch protection is documented, not applied by this PR.** It is a repository setting; the `gh` CLI and the GitHub MCP tools available in this session have no endpoint for it that the session is authorised to call, and a required-check rule can only reference a check name after that check has run once on the repo. The task doc will list the exact settings (require the `checks` and `integration` status checks, require branches to be up to date). Applying them is a two-minute click for the repo owner, and the Acceptance line is verified against the workflow itself in §5.
5. **`.env` is not needed in CI.** `DATABASE_URL` / `REDIS_URL` are set as job-level `env:` with the compose defaults, the same values `.env.example` documents. No secrets exist in this project.
6. **No commitlint job.** Commit messages are enforced by the Husky hook locally; a squash merge rewrites them anyway. Not in Scope.

---

## 4. Files

| File                       | New / Changed | Why                         |
| -------------------------- | ------------- | --------------------------- |
| `.github/workflows/ci.yml` | New           | The pipeline                |
| `package.json` (root)      | Changed       | `build` script (decision 2) |

---

## 5. Test plan

**Tests:** none new — the Scope line says so. The pipeline runs the 8 unit and 14 integration tests that already exist.

**How the pipeline will be proven able to fail (the Acceptance line):** push a commit containing a deliberate lint error (an unused variable) to this branch, watch the `checks` job go red on the lint step and the `integration` job be skipped, then revert the commit and watch both go green. Both runs are linked from the task doc. The devops agent brief: "an untested gate is not a gate".

| Level       | Test | What it would catch |
| ----------- | ---- | ------------------- |
| Unit        | N/A  | —                   |
| Integration | N/A  | —                   |
| Concurrency | N/A  | —                   |

---

## 6. Risks and failure modes

- **What if Redis is down?** In CI, `docker compose up --wait` fails the job before any test runs, with the compose logs attached. Nothing in the integration suite talks to Redis yet (TB-017), but the service is started now so the job's shape does not change later.
- **What if a key is evicted under `allkeys-lru`?** N/A.
- **What if this operation runs twice?** Two pushes in quick succession: `concurrency` cancels the older run. Re-running a job is idempotent — the compose stack is fresh per runner.
- **What if it dies halfway through?** A runner lost mid-job shows as a failed run; re-run it. No state outlives the runner.

---

## 7. Could Postgres already do this?

N/A — no Redis capability is being added.

---

## 8. Open questions

None blocking. Decision 4 (branch protection left to the repo owner) is the one a reviewer might want done differently.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-005-ci-pipeline.md`, including the exact branch-protection settings
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
