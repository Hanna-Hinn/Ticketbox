# TB-002 — Docker compose stack

**Status:** Merged
**Date completed:** 2026-08-27
**Task:** TB-002 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-002-docker-compose-stack.md`](../implementation-plans/TB-002-docker-compose-stack.md)
**Branch / PR:** `feat/TB-002-docker-compose-stack` · (PR not yet opened)
**ADR:** none — nothing here is a Redis/Postgres mechanism decision in the sense `CLAUDE.md` §6.12 means. The real findings below are operational/Docker gotchas, and the task doc is their right home.

---

## What this task delivered

`docker-compose.yml` bringing up Postgres 16, Redis 7, and RedisInsight, all genuinely healthchecked. `.env.example` with credentials matching the compose file's own defaults. Two one-command setup scripts (`scripts/dev-up.sh`, `scripts/dev-up.ps1`) that run `docker compose up -d --wait` and then verify each service actually answers — `redis-cli ping`, `psql -c 'select 1'`, and an HTTP check on RedisInsight — printing a clear summary or failing loudly and specifically.

No application code touches any of this yet. TB-003 (typed config) and TB-004 (migrations) are the first real consumers.

---

## How it works

```
./scripts/dev-up.sh (or .ps1)
  → docker info                         preflight: is Docker even running?
  → docker compose up -d --wait         blocks until every healthchecked
                                         service reports healthy
  → docker compose exec redis redis-cli ping
  → docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" ...'
  → curl / Invoke-WebRequest :5540
  → print where everything is
```

The postgres check reads `$POSTGRES_USER`/`$POSTGRES_DB` from _inside_ the container (via `sh -c`), where docker-compose.yml already set them — the script never duplicates credentials, so it can't drift out of sync with `.env`.

### Layers touched

Pure infrastructure — no `domain/`, `application/`, `infrastructure/`, or `main/` code exists yet.

### Key files

| File                         | What it does                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`         | Three services, three real healthchecks (see §3 — `redisinsight`'s was a genuine bug fix, not a copy-paste) |
| `.env.example`               | Credentials + `DATABASE_URL`/`REDIS_URL`, matching the compose file's defaults exactly                      |
| `scripts/dev-up.sh` / `.ps1` | One-command bring-up + verification, per platform                                                           |
| `.gitattributes`             | New — pins `*.sh` to LF, so Windows's `core.autocrlf` can't corrupt the bash shebang on a future checkout   |

### Redis keys / Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

This task had more real findings than TB-001, all discovered by actually running things rather than assuming the plan's design was correct on paper.

| Planned                                                                                                                                                       | What actually happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redisinsight` gets no explicit healthcheck — `--wait` treats a container with none as ready once it's running (this was the plan's own stated reasoning, §3) | **Wrong in practice.** First real run: `curl http://localhost:5540` returned `curl: (52) Empty reply from server` immediately after `--wait` returned successfully. The container was _running_, but RedisInsight's Node server hadn't started accepting connections yet — "running" and "actually serving" are different guarantees, and only the second one is useful. Added a real healthcheck: `wget --spider -q http://127.0.0.1:5540`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Discovered by running the script for real, not by reading the compose file. This is exactly the gap between "the container process started" and "the service is ready" that `--wait` can't close for you when there's no healthcheck to wait on.                                                                                                           |
| (the healthcheck fix above) — first attempt used `http://localhost:5540`                                                                                      | Failed with `Connection refused` from _inside_ the container, while the identical URL worked fine from the host. Root cause, confirmed directly: the container's `/etc/hosts` resolves `localhost` to `::1` first, but RedisInsight's Node process only binds `0.0.0.0` (IPv4) — `netstat` inside the container showed `0.0.0.0:5540`, nothing on `::`. Using `127.0.0.1` explicitly fixed it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A real, non-obvious IPv6-vs-IPv4 gotcha specific to this image. Documented as a comment directly in `docker-compose.yml` so the next person touching this file doesn't "simplify" it back to `localhost`.                                                                                                                                                  |
| §5's "prove it can fail" proof #1: typo the Postgres healthcheck's `-U` flag, confirm `docker compose ps` reports unhealthy                                   | **The plan's own proof design was wrong.** Typoing `-U` to a nonexistent user did _not_ make the healthcheck fail — `docker inspect`'s health log showed `ExitCode: 0, "accepting connections"` every time. `pg_isready` is a pure liveness/readiness check; it does not authenticate. Confirmed independently with a throwaway `-U totally_bogus_user_xyz` exec. Redid the proof against something that actually breaks liveness (wrong port, `-p 9999`), which correctly produced `ExitCode: 2, "no response"` and flipped the container to unhealthy.                                                                                                                                                                                                                                                                                                                                          | This is a good finding on its own terms, separate from the docker-compose.yml itself: the healthcheck's _design_ was already correct (a container healthcheck should check liveness, not validate a specific user's credentials) — the plan's proposed _test methodology_ for proving that was based on a wrong assumption about what `pg_isready` checks. |
| No env var flagged as a risk in the plan's §6                                                                                                                 | **Code review found a real one anyway.** Postgres only applies `POSTGRES_USER`/`PASSWORD`/`DB` when it _initializes_ the `pgdata` volume — changing `.env` later and re-running `up` silently has no effect on an already-initialized volume, and nothing in this diff would have caught that until `DATABASE_URL` tried to authenticate for real (TB-003+). Added a comment to `.env.example` explaining it and the `docker compose down -v` fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                | Caught by `engineering-code-reviewer`, not by any of the manual verification above — a good demonstration of why the review step exists as a distinct phase from "I tested it and it worked."                                                                                                                                                              |
| —                                                                                                                                                             | **Critical review finding, unrelated to anything above:** `scripts/dev-up.sh` was committed with git mode `100644`, not `100755` — confirmed via `git ls-files -s`. This repo has `core.filemode=false` (normal for Windows/Git-for-Windows), so my local `chmod +x` set the _working-tree_ bit but `git add` never carried it into the index. Every one of my own successful script runs was against that already-executable working-tree file — none of them could have caught this, because the bug only exists in what a _fresh clone_ receives. On real Linux/macOS/CI, `./scripts/dev-up.sh` — the literal first command in the new Quick Start — would fail with `Permission denied` before Docker is ever touched. Fixed with `git update-index --chmod=+x`, plus `.gitattributes` (`*.sh text eol=lf`) so `core.autocrlf` can't corrupt the shebang on a future Windows checkout either. | **The most important finding in this task.** It's the clearest possible demonstration of why Phase 3 is a mandatory, distinct step and not something a solo implementer's own testing can substitute for — the bug was invisible from inside the exact environment doing all the "real verification," by construction.                                     |

---

## 4. Tests shipped

None — the delivery plan's own Tests line is explicit: **none (infrastructure)**. Acceptance was verified directly instead, every command run for real with output observed:

```
$ docker compose ps
ticketbox-postgres-1       Up ... (healthy)
ticketbox-redis-1          Up ... (healthy)
ticketbox-redisinsight-1   Up ... (healthy)

$ docker compose exec redis redis-cli ping
PONG

$ docker compose exec postgres psql -U ticketbox -d ticketbox -c 'select 1'
 ?column?
----------
        1
(1 row)

$ curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5540
HTTP 200
```

**Proven able to fail — five separate proofs, each broken deliberately and reverted:**

1. Wrong Postgres port in the healthcheck → `docker inspect`'s health log showed real `ExitCode: 2, "no response"`; container flipped to unhealthy. Reverted.
2. `./scripts/dev-up.sh` and `dev-up.ps1` both run against that broken healthcheck → both stopped at the `--wait` step (`container ticketbox-postgres-1 is unhealthy`, exit 1) and never reached the ping checks or printed a false "all up." Reverted.
3. `./scripts/dev-up.sh` run before Docker Desktop was started → preflight caught it, printed the friendly message, exit 1 (this is what surfaced needing to start Docker Desktop in the first place — not staged after the fact).
4. `dev-up.ps1` run with `$env:DOCKER_HOST` pointed at an unreachable address → same preflight, same clean failure, exit 1.
5. Idempotency: `./scripts/dev-up.sh` run twice in a row against already-healthy containers → second run identical output, exit 0, no side effects.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool for real this time (TB-001 self-applied the rubric instead; this task validates the actual subagent)
**Verdict:** NEEDS WORK → fixed → re-reviewed → **SAFE TO MERGE**

| Finding                                                                                                                                                          | Severity | Resolution                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `scripts/dev-up.sh` committed non-executable (`100644`) — every fresh clone on Linux/macOS/CI gets `Permission denied` on the documented one-command entry point | Critical | Fixed — `git update-index --chmod=+x`, plus `.gitattributes` to prevent regression via `core.autocrlf` |
| No warning that Postgres ignores `.env` credential changes against an already-initialized volume                                                                 | Major    | Fixed — comment added to `.env.example`                                                                |

Findings deliberately not fixed: none.

**One finding regressed after the re-review confirmed it fixed, caught only by re-verifying the pushed state rather than trusting the earlier check.** Wrapping up Phase 5, a `git reset` before the final commits (unstaging to recombine files into cleaner commit groups) was followed by a plain `git add scripts/dev-up.sh` — which silently re-lost the executable bit, because `core.filemode=false` means `git add` never reads the working-tree permission bit at all; only the explicit `git update-index --chmod=+x` sets it, and that fix doesn't survive a reset. The feat commit that reached the remote branch had the bug back. Caught by re-running `git ls-files -s` after pushing rather than assuming the earlier fix still held, fixed with a follow-up commit, verified `100755` both in the index before committing and via `git show --stat` after. The exact bug the code review caught once already recurred, mechanically, in the documentation phase of the same task — a fairly direct demonstration of why "verify the actual state, don't trust that a fix made ten minutes ago is still there" has to apply to the implementer's own git operations, not just to test output.

---

## 6. Failure modes, as built

- **Redis down:** N/A — nothing depends on it yet.
- **Key evicted under `allkeys-lru`:** N/A — no `maxmemory` policy set (TB-040).
- **Operation runs twice:** Verified directly — `./scripts/dev-up.sh` run twice against already-healthy containers is a clean no-op both times.
- **Dies halfway through:** Not independently destructively tested (e.g. `docker kill` mid-`up`) — named volumes mean Postgres/Redis data survives a `down`/`up` cycle by Compose's own design, but that specific scenario wasn't exercised this task. Worth doing as part of TB-040's operations experiments, which already own this kind of test.

---

## 7. What I'd do differently

Would have run the "prove it can fail" checks _before_ writing them into the plan as a description, not after — the `pg_isready` username-doesn't-authenticate discovery would have been made during planning instead of implementation, and the plan's §5 would have named the right proof (wrong port, not wrong user) from the start instead of needing a correction mid-implementation.

Would also have asked the code reviewer to check the git-mode/line-ending situation on _every_ task involving a new executable script, proactively, rather than relying on it to notice — it did notice unprompted here, but a Windows-authored shell script is specifically the situation where this bug recurs, and it's cheap to call out explicitly next time.

---

## 8. Follow-ups left behind

- [ ] TB-040's operations experiments should include a `docker kill` (not `stop`) mid-write test against the named volumes — not exercised in this task.
- [ ] TB-005 (CI) should confirm `scripts/dev-up.sh` actually runs (not just `docker compose up -d --wait` directly) on its Linux runner — that's the test that would have caught the executable-bit bug automatically if this task had shipped it unfixed.
- [ ] `docker-compose.yml`'s `redisinsight` healthcheck comment (the IPv6/`localhost` gotcha) is worth remembering if RedisInsight's image ever gets bumped past `:latest`'s current behavior — re-verify the comment is still accurate if that health check ever needs touching.
