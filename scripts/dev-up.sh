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
