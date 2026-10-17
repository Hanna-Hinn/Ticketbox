# TB-005 — CI pipeline

**Status:** In review (PR open, stacked — not merged by design). **Branch protection still to be applied by the repo owner — see §9.**
**Date completed:** 2026-10-17
**Task:** TB-005 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-005-ci-pipeline.md`](../implementation-plans/TB-005-ci-pipeline.md)
**Branch / PR:** `feat/TB-005-ci-pipeline` · [#8](https://github.com/Hanna-Hinn/Ticketbox/pull/8) (based on #7)
**ADR:** none.

---

## What this task delivered

`.github/workflows/ci.yml`: every PR, whatever its base branch, now runs `typecheck → lint → test:unit → build` as one fail-fast job, and, only if that passed, a second job that brings up Postgres and Redis from the compose file, runs `pnpm migrate && pnpm seed`, and runs the integration suite. The TB-004 acceptance line is now exercised on every PR on a fresh machine. The pipeline was proven to go red and to go green again.

---

## How it works

```
pull_request (any base) · push to main
  checks        ubuntu-24.04 · node 22 · pnpm from packageManager · ~18 s
    install --frozen-lockfile → typecheck → lint → test:unit → build
    (sequential steps: the first failure stops the job; later steps show as skipped)
  integration   needs: checks · ~26 s
    docker compose up -d --wait postgres redis       ← TB-002's healthchecks gate this
    pnpm migrate → pnpm seed → pnpm test:integration ← job-level DATABASE_URL / REDIS_URL
    on failure: docker compose logs
```

Observed runs on #8, oldest first:

| Run                                                                             | What                              | `checks`                               | `integration` |
| ------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------- | ------------- |
| [39036300063](https://github.com/Hanna-Hinn/Ticketbox/actions/runs/39036300063) | first run of the workflow         | ✅ 18 s                                | ✅ 26 s       |
| [39036551267](https://github.com/Hanna-Hinn/Ticketbox/actions/runs/39036551267) | deliberate lint error (`0a32a0c`) | ❌ 16 s — `typecheck` Done, `lint` red | ⏭ skipped     |
| [39036728001](https://github.com/Hanna-Hinn/Ticketbox/actions/runs/39036728001) | revert + review fixes             | ✅ 19 s                                | ✅ 35 s       |

The sabotage proof, from the job log of the red run:

```
$ pnpm -r --if-present run typecheck
packages/api typecheck: Done
$ eslint . --max-warnings 0
/home/runner/work/Ticketbox/Ticketbox/packages/api/src/main/lint-sabotage.ts
##[error]  2:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars
✖ 1 problem (1 error, 0 warnings)
##[error]Process completed with exit code 1.
```

Typecheck green, lint red, unit/build never ran, integration skipped — the order the handbook specifies, observed. The sabotage commit was pushed with `--no-verify` because the Husky pre-commit hook would have stopped it locally, which is the point of the hook but not the point of this test.

### Layers touched

None. One workflow file and one root script.

### Key files

| File                       | What it does                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` | The two jobs above                                                                                                                                                                          |
| `package.json`             | `build`: `pnpm -r --if-present run build` — **a no-op until TB-014** adds `vite build`; it tests nothing today and is wired only because the Scope line and the handbook's CI order name it |

---

## 3. Where this diverged from the plan

| Planned                                                                                   | What actually happened                                                                                                                                                                                                                                                                                                                               | Why                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Decision 4: "require the `checks` and `integration` status checks" — implicitly on `main` | **Wrong target.** This repo's PRs are stacked onto `feat/*` branches. A rule on `main` would leave #8 itself (base `feat/TB-004-…`) mergeable while red. The protection must be a **ruleset targeting all branches** (§9). Caught by the Phase 3 review.                                                                                             | The plan reasoned about "the merge" as if every PR targeted `main`.                                         |
| `cancel-in-progress: true` for every ref                                                  | Now `${{ github.event_name == 'pull_request' }}`. Two squash merges minutes apart would have cancelled the first `main` run, leaving a commit on `main` with no verdict.                                                                                                                                                                             | Review (Major). The saving was meant for superseded PR runs only.                                           |
| No timeouts, no `permissions:`                                                            | `timeout-minutes: 10` / `15`; `permissions: contents: read`.                                                                                                                                                                                                                                                                                         | Review (Minor). The default job timeout is 360 minutes; a hung connect after `--wait` would burn all of it. |
| "Node 22" pinned                                                                          | Kept as a **major-only** pin. The runner resolves the current 22.x, which can drift from a developer's `22.22.0`. Accepted: a `.nvmrc` would be a file outside the plan, and nothing in this project is sensitive to a 22.x patch.                                                                                                                   | Review (Minor) asked for the choice to be stated, not necessarily changed.                                  |
| —                                                                                         | GitHub warns that `actions/checkout@v4`, `actions/setup-node@v4` and `pnpm/action-setup@v4` target Node 20 and are forced onto Node 24. Harmless today; left as is because the next majors' tags were not verified from this session (reading other repositories is out of scope here) and guessing a version is exactly what the repo rules forbid. | Follow-up in §8.                                                                                            |

---

## 4. Tests shipped

None new — the Tests line says so. The pipeline runs the existing 8 unit and 14 integration tests on every PR.

**Proven able to fail:** run 39036551267 above. Reverted in the next commit; the revert run (39036728001) is green on both jobs.

**Coverage after this task:** not enforced by CI. The handbook says "Global: 80% — CI fails below", but `vitest.unit.config.ts` only applies thresholds under `--coverage`, which the pipeline does not pass. Deliberate: with `domain/` and `application/` still empty the global threshold would fail against `main/*.ts` entry points today. **TB-042** ("enforce coverage thresholds in CI") is where `--coverage` joins the `checks` job.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran every step locally except `docker compose up --wait` (no daemon in the session's sandbox), including the integration commands with only the two job-level env vars exported and no `.env`.
**Verdict:** SAFE TO MERGE as code; "the task is not done at merge" until the ruleset in §9 is applied and the merge button is observed blocked.

| Finding                                                                                    | Severity | Resolution                                                                      |
| ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------- |
| Planned branch protection targets `main`; stacked PRs target `feat/*` → red but mergeable  | Major    | §9 specifies a ruleset on all branches; not applicable from this session (403)  |
| `cancel-in-progress` unconditional cancels `main` runs                                     | Major    | Fixed — conditional on `pull_request`                                           |
| Handbook promises a coverage gate the pipeline does not enforce                            | Major    | Recorded above; TB-042 owns it. Not added here (out of Scope, would fail today) |
| No `timeout-minutes`                                                                       | Minor    | Fixed — 10 / 15                                                                 |
| No `permissions:` block                                                                    | Minor    | Fixed — `contents: read`                                                        |
| `node-version: 22` is a major-only pin                                                     | Minor    | Kept; stated in §3                                                              |
| `docker-compose.yml` pins `redis/redisinsight:latest` (TB-002 artefact, not started by CI) | Noticed  | Not touched — not this task's file. Listed in §8                                |

Findings deliberately **not** fixed: coverage (TB-042), Node patch pin, redisinsight tag.

---

## 6. Failure modes, as built

- **Redis down:** `docker compose up -d --wait` exits non-zero when a healthcheck never passes; the job fails before any test runs and `docker compose logs` is attached. Not yet exercised by a test (nothing talks to Redis until TB-017).
- **Key evicted under `allkeys-lru`:** N/A.
- **Operation runs twice:** two pushes to a PR in quick succession — the older run is cancelled. Two pushes to `main` — both run to completion (fixed in review). Re-running a job: the runner is fresh, so migrate applies all five files again and seed inserts 3/9 again.
- **Dies halfway through:** a lost runner is a failed run; nothing outlives it. Re-run.

---

## 7. What I'd do differently

Think about _which branch_ the merge button belongs to before writing "branch protection" in a plan for a repo whose PRs are stacked. The whole point of the Acceptance line is the merge button, and the plan reasoned about `main` by reflex.

---

## 8. Follow-ups left behind

- [ ] **Apply the ruleset in §9** (repo owner; needs no code).
- [ ] TB-042: add `--coverage` to the `checks` job once `domain/` and `application/` exist.
- [ ] Bump `actions/checkout`, `actions/setup-node`, `pnpm/action-setup` to their Node-24 majors once the tags are verified; GitHub's deprecation warning is informational today.
- [ ] `docker-compose.yml`: `redis/redisinsight:latest` violates the "pin versions" rule (TB-002). Not started by CI, so harmless there; pin it when the compose file is next touched for a task.

---

## 9. Branch protection — the settings to apply

A repository setting, not a file; this session's token returns 403 on the protection and ruleset endpoints. **Sequencing matters:** a required-status-check rule can only reference check names that have already appeared on a run — both `checks` and `integration` have (run 39036300063), so this can be applied now.

It must be a **ruleset targeting all branches**, not classic protection on `main`: the stacked PRs in this repo target `feat/*` branches, and a `main`-only rule would leave them mergeable while red.

Via the UI: _Settings → Rules → Rulesets → New branch ruleset_ — name `ci-required`, enforcement **Active**, target branches **All branches**, rules: **Require a pull request before merging** (0 approvals is fine for a solo repo), **Require status checks to pass** with `checks` and `integration` added and **Require branches to be up to date** ticked.

Via the API (field names per the rulesets reference — verify before pasting):

```bash
gh api -X POST repos/Hanna-Hinn/Ticketbox/rulesets --input - <<'EOF'
{
  "name": "ci-required",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "checks" }, { "context": "integration" } ] } }
  ]
}
EOF
```

**What to verify afterwards:** push any lint error to any open PR and confirm the merge button reads "Required statuses must pass" — on a PR whose base is a `feat/*` branch, not just one targeting `main`. Then revert and confirm it unblocks. Until that has been seen, the Acceptance line ("a PR with a lint error cannot merge") is satisfied in the workflow but not yet in the repository.
