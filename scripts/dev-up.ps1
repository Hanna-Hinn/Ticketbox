# One command: bring up postgres/redis/redisinsight and confirm they actually work.
# Targets PowerShell 7+ (pwsh).

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
