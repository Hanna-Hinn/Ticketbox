# TB-002 — Docker compose stack

**Status:** Implemented — see [`docs/tasks/TB-002-docker-compose-stack.md`](../tasks/TB-002-docker-compose-stack.md) for what actually happened, including a real cross-platform bug the code review caught that no amount of testing on this machine could have found
**Date:** 2026-08-27
**Task:** TB-002 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-002-docker-compose-stack`
**Approved by:** Hanna
**Approved on:** 2026-08-27 — including the dev-up.sh/dev-up.ps1 addition (see §3)

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `postgres:16-alpine`, `redis:7-alpine`, `redis/redisinsight:latest`. Named volumes. Redis with `--appendonly no` for now (TB-040 changes this). `.env.example`.

**Acceptance:** `docker compose up -d` gives three healthy containers. `redis-cli ping` and `psql -c 'select 1'` both succeed. RedisInsight opens at `:5540` and connects.

**Tests:** none (infrastructure).

**Depends on:** none listed in the delivery plan. Sequenced right after TB-001 because "everything downstream needs both engines running locally," but nothing here reads `packages/api`'s code, so it doesn't block on TB-001 being merged.

---

## 2. What I understand this to mean

A `docker-compose.yml` at the repo root that brings up Postgres, Redis, and RedisInsight with a single command, healthy and reachable, with no application code touching them yet — TB-003 (typed config) and TB-004 (migrations) are what actually make use of them. `.env.example` documents the credentials the compose file expects, in a shape TB-003's `DATABASE_URL` parsing can consume directly, so that task doesn't have to redefine it.

No design question here — no ports, no Lua, no schema, nothing Redis/Postgres-architectural to decide. `engineering-backend-architect` isn't warranted; this is `engineering-devops-automator`'s territory (compose, healthchecks, reproducibility), and the task is small enough I'm writing the plan directly rather than dispatching it.

**Explicit addition, requested during planning, beyond the delivery plan's verbatim Scope:** a one-command setup script per platform (`scripts/dev-up.sh`, `scripts/dev-up.ps1`) that runs `docker compose up -d --wait`, then runs the exact two checks TB-002's own Acceptance line names (`redis-cli ping`, `psql -c 'select 1'`), then confirms RedisInsight is reachable, then prints where everything is. This is, almost word for word, an automated version of the Acceptance line itself — not new scope so much as making the existing scope runnable in one step instead of five.

---

## 3. Approach

### Layers touched

| Layer | What changes                                    |
| ----- | ----------------------------------------------- |
| L1–L4 | None — pure infrastructure, no application code |

### New or changed ports / Redis keys / Lua scripts

None.

### Migrations

None — TB-004's job.

### Decisions this plan is making

**`REDIS_URL` as the naming convention for Redis's connection string**, by direct analogy to `DATABASE_URL` — the only env var name the delivery plan commits to explicitly (TB-003's Acceptance line). Nothing in the docs names the Redis equivalent; `REDIS_URL` is the obvious, low-risk choice, and TB-017 ("Redis client... needs TB-002, TB-003") will be the first real consumer.

**Ports are hardcoded in `docker-compose.yml`, not templated via env vars.** TB-002's own Acceptance line hardcodes `:5540`; nothing calls for configurable ports on a single local dev machine, and adding that flexibility would be exactly the kind of "configurability nobody requested" the anti-slop rules warn against. Only Postgres credentials go through `${VAR:-default}` interpolation, because credentials genuinely should be env-driven.

**Defaults in `docker-compose.yml` are self-sufficient — a fresh clone doesn't need `.env` to satisfy Acceptance.** `docker compose up -d` must work immediately after clone, with no setup step, so every `${VAR:-default}` fallback matches `.env.example`'s documented value exactly. `.env.example` exists for discoverability and customization, not as a hard requirement to run the stack.

**`redis/redisinsight:latest`, unpinned — matches the delivery plan's own scope line verbatim.** Postgres and Redis get pinned major-version tags (`16-alpine`, `7-alpine`); RedisInsight is a debugging UI with no correctness surface for this project, and the plan itself names `:latest` for it specifically.

**Filename stays `docker-compose.yml`**, not the newer `compose.yaml` spelling, because that's what §2.4's folder structure, `CLAUDE.md`, and `README.md` already reference in multiple places. Renaming it would be an unforced inconsistency.

**The setup scripts use `docker compose up -d --wait` rather than hand-rolling a healthcheck-polling loop.** Compose (v2.10+; this machine has v5.0.2) already blocks until every service with a healthcheck reports healthy, and treats a service with no healthcheck (`redisinsight`) as ready once it's running — reimplementing that in bash/PowerShell would be duplicating a feature the tool already has. The explicit `redis-cli ping` / `psql select 1` calls afterward aren't redundant with `--wait`: they're the literal checks TB-002's Acceptance line names, and they prove the _service_ answers, not just that the _container_ is healthy.

**Postgres credentials are read from inside the container, not duplicated into the script.** The check runs as `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select 1"'` — `$POSTGRES_USER`/`$POSTGRES_DB` are expanded by `sh` _inside_ the container, where docker-compose.yml already set them. The script never hardcodes or re-reads credentials, so it can't drift out of sync with `.env`/`.env.example`.

**PowerShell needs an explicit `$LASTEXITCODE` check after every native `docker` call.** Unlike a cmdlet failure, a non-zero exit from a native `.exe` doesn't automatically become a terminating error `try`/`catch` can catch — that behavior depends on a preference variable (`$PSNativeCommandErrorActionPreference`) this plan isn't assuming is set. The script checks `$LASTEXITCODE` directly after each `docker` invocation instead, which works regardless of that setting. This will be verified for real in Phase 2, not just reasoned through — PowerShell/bash quoting is exactly the kind of thing TB-001 already proved shouldn't be assumed correct on paper.

**Both scripts get proposed in full below**, since a script's real content is what's actually being approved, not a one-line description of it.

#### `scripts/dev-up.sh`

```bash
#!/usr/bin/env bash
# One command: bring up postgres/redis/redisinsight and confirm they actually work.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker doesn't seem to be running. Start Docker Desktop and try again." >&2
  exit 1
fi

echo "==> Starting postgres, redis, redisinsight..."
docker compose up -d --wait

echo "==> Checking redis..."
docker compose exec -T redis redis-cli ping

echo "==> Checking postgres..."
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select 1"'

echo "==> Checking redisinsight..."
curl -sf -o /dev/null http://localhost:5540

echo
echo "All three containers are up and responding:"
echo "  Postgres:     localhost:5432"
echo "  Redis:        localhost:6379"
echo "  RedisInsight: http://localhost:5540 (open it to confirm it connects to Redis)"
```

#### `scripts/dev-up.ps1`

Targets PowerShell 7+ (`pwsh`) — this repo's own tooling already assumes it.

```powershell
# One command: bring up postgres/redis/redisinsight and confirm they actually work.

function Invoke-Checked {
    param([string]$Description, [scriptblock]$Command)
    Write-Host "==> $Description"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Description failed (exit $LASTEXITCODE)."
        exit 1
    }
}

Set-Location (Join-Path $PSScriptRoot "..")

docker info *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker doesn't seem to be running. Start Docker Desktop and try again."
    exit 1
}

Invoke-Checked "Starting postgres, redis, redisinsight" { docker compose up -d --wait }
Invoke-Checked "Checking redis" { docker compose exec -T redis redis-cli ping }
Invoke-Checked "Checking postgres" { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select 1"' }

Write-Host "==> Checking redisinsight"
try {
    Invoke-WebRequest -Uri "http://localhost:5540" -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
    Write-Error "RedisInsight not reachable at http://localhost:5540: $_"
    exit 1
}

Write-Host ""
Write-Host "All three containers are up and responding:"
Write-Host "  Postgres:     localhost:5432"
Write-Host "  Redis:        localhost:6379"
Write-Host "  RedisInsight: http://localhost:5540 (open it to confirm it connects to Redis)"
```

Not wiring these into TB-005's CI pipeline — that task owns CI and can choose to reuse `dev-up.sh` there or keep its own `--wait` call; not this task's decision to make for it.

---

## 4. Files

| File                 | New / Changed | Why                                                                                                                              |
| -------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` | New           | Three services: `postgres`, `redis`, `redisinsight` — named volumes, healthchecks, `redisinsight` waits on `redis` being healthy |
| `.env.example`       | New           | `POSTGRES_USER`/`PASSWORD`/`DB`, `DATABASE_URL`, `REDIS_URL` — values matching the compose file's own defaults                   |
| `scripts/dev-up.sh`  | New           | One-command bring-up + verification, bash (macOS/Linux/Git Bash)                                                                 |
| `scripts/dev-up.ps1` | New           | Same, PowerShell 7+                                                                                                              |
| `README.md`          | Changed       | Point at the scripts as the recommended one-command start, alongside the raw `docker compose up -d`                              |
| `CLAUDE.md`          | Changed       | Same, in "Local commands"                                                                                                        |

Anything not in this table is out of scope for this PR — in particular, no `main/config.ts` (TB-003), no migrations (TB-004), no changes to a future CI pipeline (TB-005).

---

## 5. Test plan

| Level       | Test                            | What it would catch |
| ----------- | ------------------------------- | ------------------- |
| Unit        | N/A                             | —                   |
| Integration | N/A                             | —                   |
| Concurrency | N/A — no inventory logic exists | —                   |
| Smoke       | N/A — TB-013                    | —                   |
| E2E         | N/A — TB-016                    | —                   |

The delivery plan's own Tests line is explicit: **none (infrastructure)**. Acceptance is verified directly instead, with real commands, output pasted into the task doc:

```bash
docker compose up -d
docker compose ps                                    # three services, all "healthy"
docker compose exec redis redis-cli ping              # PONG
docker compose exec postgres psql -U ticketbox -d ticketbox -c 'select 1'
curl -sf http://localhost:5540                        # RedisInsight UI reachable
```

**How this would be proven able to fail — three separate proofs, each broken deliberately and reverted:**

1. Temporarily typo the Postgres healthcheck's `-U` flag to a nonexistent user, confirm `docker compose ps` reports the container unhealthy (not just "up"), then revert. Confirms the healthcheck itself checks something.
2. Run `scripts/dev-up.sh` (and the `.ps1`) with Docker Desktop stopped, confirm the preflight check reports the friendly error and exits non-zero rather than falling through to a confusing `docker compose` failure.
3. Run the script against the deliberately-broken healthcheck from proof 1, confirm `docker compose up -d --wait` itself times out and returns non-zero, and that the script stops there — it must not reach the `redis-cli ping`/`psql` checks and print a false "all up" summary.

---

## 6. Risks and failure modes

- **What if Redis is down?** N/A to this task — nothing depends on it being up yet. Relevant from TB-017 onward.
- **What if a key is evicted under `allkeys-lru`?** N/A — no `maxmemory` policy is set in this task; that's TB-040.
- **What if this operation runs twice?** `docker compose up -d` is idempotent by design (Compose's own contract) — running it against already-running healthy containers is a no-op. Will verify directly.
- **What if it dies halfway through?** Named volumes mean `docker compose down` (without `-v`) and a fresh `up -d` recovers Postgres/Redis data. `docker compose down -v` is destructive and intentionally not part of the normal flow — noting this so it isn't reached for casually later.

---

## 7. Could Postgres already do this?

N/A — this task doesn't add a Redis capability to weigh against Postgres; it stands up both engines side by side.

---

## 8. Open questions

None blocking.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed. Nothing here is a Redis/Postgres mechanism decision in the sense `CLAUDE.md` §6.12 means (Lua vs. `WATCH`, cache-aside vs. write-through). The naming/scoping calls in §3 are recorded there instead.
- ☑ Task doc — `docs/tasks/TB-002-docker-compose-stack.md` — always
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
