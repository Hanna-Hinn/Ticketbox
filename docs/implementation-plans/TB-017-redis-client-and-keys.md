# TB-017 — Redis client and key registry

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-017 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-017-redis-client-and-keys` (stacked on `feat/TB-016-first-e2e`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `ioredis` singleton with lifecycle logging (`connect`, `ready`, `error`, `reconnecting`). `infrastructure/redis/keys.ts` exporting key-building functions with a `ticketbox:v1:` prefix.

**Acceptance:** `/health` reports Redis status. Killing the container leaves the process alive.

**Tests:** **integration** — client connects, `set`/`get` round-trips, key builders produce the documented shapes.

**Depends on:** TB-002, TB-003 (merged on `main`) — confirmed: ☑

---

## 2. What I understand this to mean

Redis enters the system, and only as a driver. Nothing in this task uses it for anything: no cache (TB-018), no hold store (TB-022). What it delivers is the connection the later tasks share, created once in the composition root and closed with the rest of the system; a `redis` entry in `/health`; a log line for every lifecycle event, which is the only way a disconnect is ever noticed; and the key registry, the one place a Redis key string may be written.

"Killing the container leaves the process alive" is the acceptance line that matters, and it is about one thing: an `ioredis` client is an `EventEmitter`, and an `error` event with no listener terminates a Node process. The lifecycle logging is not decoration; the `error` listener is what keeps the API up while Redis is gone, and the reconnect that follows is what brings it back without a restart.

---

## 3. Approach

### Layers touched

| Layer                      | What changes                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| L1, L2                     | None                                                                                                  |
| L3 `infrastructure/redis/` | New: `client.ts` (`createRedisClient`), `keys.ts` (the registry)                                      |
| L4 `main/composition.ts`   | Creates the client, adds the `redis` health closure, `quit()`s it in `close()`                        |
| tests                      | `test/integration/support/redis.ts` (DB 9, `FLUSHDB`), `test/integration/redis/{client,keys}.test.ts` |
| smoke                      | #1 asserts `redis: "ok"` as TB-013 promised                                                           |

### The client

```ts
// infrastructure/redis/client.ts
export function createRedisClient(url: string, log: Logger): Redis
  new Redis(url, { lazyConnect: false })            // connects at compose time, like the pg Pool
  .on("connect",      () => log.info("redis connected"))
  .on("ready",        () => log.info("redis ready"))
  .on("error",        (err) => log.error({ err }, "redis error"))        ← the listener that keeps the process alive
  .on("reconnecting", (delayMs) => log.warn({ delayMs }, "redis reconnecting"))
  .on("end",          () => log.warn("redis connection ended"))
```

`Logger` is pino's type: `client.ts` is L3 infrastructure and may import a driver's types; the composition root passes `log.child({ component: "redis" })`.

### The key registry

```ts
// infrastructure/redis/keys.ts — every Redis key in the system is built here
export const KEY_PREFIX = "ticketbox:v1:";
export const keys = {
  tier:      (id: TierId)   => `ticketbox:v1:tier:{<id>}`          // hash: remaining  (TB-022)
  tierHolds: (id: TierId)   => `ticketbox:v1:tier:{<id>}:holds`    // zset: token → expiresAt  (TB-022/026)
  hold:      (t: HoldToken) => `ticketbox:v1:hold:<t>`             // hash: the live hold  (TB-022)
} as const;
```

The shapes are the ones the delivery plan already writes down: `ticketbox:v1:hold:*` (TB-040), `tier:{id}:holds` (TB-026), the per-tier hash TB-021/022 `HGET`/`HINCRBY` against. The braces are Redis hash tags: both tier keys hash to the same slot, so a Lua script touching both stays valid if a cluster ever appears. Single node today; the comment says so.

### Decisions this plan is making

1. **`ioredis@^6.0.0`** — current major, released 2026-07-31, the client the handbook and the plan name throughout. The one package this task adds to `packages/api`. The ioredis API used (`new Redis(url, options)`, the five events, `ping`, `quit`, `defineCommand` later) is checked against the installed type declarations in Phase 2, not from memory — CLAUDE.md's Prime Directive names `ioredis` APIs specifically.
2. **Connect eagerly, fail soft.** `lazyConnect: false` so the client connects when `compose()` runs, like the `pg` Pool, and `enableOfflineQueue` stays at its default (`true`): a command issued while Redis is down waits for the reconnect rather than failing instantly, up to ioredis's default `maxRetriesPerRequest` (20). Nothing in this task issues commands on the request path; TB-039 decides fail-open vs fail-closed per endpoint, and that decision needs the queue, not a client that errors on first touch. The `/health` closure is bounded by TB-011's `pingWithin` (2 s), so a queued `ping` reports `down` in 2 s, not after 20 retries.
3. **The default `retryStrategy`** (ioredis 6's `min(times × 10, 1000)` ms, forever — read from the installed `RedisOptions.js`, not from memory) is kept. Reconnecting forever is what "leaves the process alive" means; a client that gives up is a client that needs a restart, which is the failure the acceptance line forbids.
4. **One client, one file, no wrapper class.** `createRedisClient(url, log): Redis` returns the driver object; the `RedisHoldStore` and `CachedEventRepository` adapters take a `Redis` in their constructors (L3 may know the driver; L2 never sees it). A `RedisClient` port would be a vendor name in a port, which rule 1 forbids, and nothing in L2 needs a Redis abstraction. The "singleton" in the Scope line is the composition root creating it once, not a module-level instance (rule 3: no singletons reached across modules).
5. **Key builders take branded ids and `HoldToken`.** Passing an `EventId` where a `TierId` belongs is the mistake CLAUDE.md says this domain invites, and the key registry is where it would be invisible. Only the three keys Stage 5 needs are defined; TB-018 adds the cache key, TB-019 the mutex and stats keys, each in the task that uses them. A registry that pre-lists keys nobody writes yet is a registry that drifts.
6. **Hash tags on the tier keys, documented.** The plan writes `tier:{id}:holds`; the braces have a meaning in Redis and the registry preserves it rather than silently dropping it. The hold key is not tagged: a `create_hold` script touching hold + tier keys would not be cluster-safe, and that is a TB-022 fact to record when the script exists, not a reason to reshape the documented hold key now.
7. **`/health` gets `redis: () => client.ping()`** through the existing `DependencyChecks` record; smoke #1 asserts `redis: "ok"` (its name has said "redis joins in TB-017" since TB-013). TB-039 decides whether a down Redis is a 503 or a 200 `degraded`; today the route already answers 503 when any check fails.
8. **`close()` calls `client.quit()`** after `app.close()` and alongside `pool.end()`; memoised with the rest. `quit` waits for pending replies; `disconnect` would not.
9. **Integration isolation per the handbook: DB index 9, `FLUSHDB` in `beforeEach`.** `test/integration/support/redis.ts` builds the test client from `REDIS_URL` (default `redis://localhost:6379`) with `db: 9` and exposes `flush()`. The application client never selects a DB; the tests do.
10. **The "container killed" acceptance is tested as a dropped connection, not a stopped server.** An integration test opens a second client and runs `CLIENT KILL` against the first's connection, then awaits the first client's `reconnecting` and `ready` events and a successful `ping` after them. No sleeping, no process-level kill, and it proves exactly what the acceptance line cares about: the error is logged, nothing throws out of the event loop, the client comes back. The literal acceptance (stop Redis under the running API, `/health` says `redis: "down"`, the process is still there, start Redis, `/health` says `ok`) is run by hand against the local server and recorded in the task doc.

### New or changed ports / Redis keys / Lua scripts

No ports. Keys: the three above (defined, not yet written to). No Lua.

---

## 4. Files

| File                                                     | New / Changed                             |
| -------------------------------------------------------- | ----------------------------------------- |
| `packages/api/src/infrastructure/redis/client.ts`        | New                                       |
| `packages/api/src/infrastructure/redis/keys.ts`          | New                                       |
| `packages/api/src/main/composition.ts`                   | Changed — client, `redis` check, `quit()` |
| `packages/api/test/integration/support/redis.ts`         | New                                       |
| `packages/api/test/integration/redis/client.test.ts`     | New                                       |
| `packages/api/test/integration/redis/keys.test.ts`       | New                                       |
| `packages/api/test/integration/main/composition.test.ts` | Changed — `/health` has both engines      |
| `packages/api/test/smoke/smoke.test.ts`                  | Changed — #1 asserts `redis: "ok"`        |
| `packages/api/package.json`, `pnpm-lock.yaml`            | Changed — `ioredis`                       |

---

## 5. Test plan

| Level       | Test                                                                                                                                                   | What it would catch                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Integration | the client connects and `ping` answers `PONG`                                                                                                          | a wrong URL / option                                         |
| Integration | `set` then `get` round-trips a value; `FLUSHDB` between tests leaves nothing behind                                                                    | the test DB not being isolated                               |
| Integration | `CLIENT KILL` on the connection → `reconnecting` then `ready` events, then `ping` succeeds; the `error` listener was called, the test process is alive | a client that dies with its connection — the acceptance line |
| Integration | `keys.tier`, `keys.tierHolds`, `keys.hold` produce the documented strings for a known id/token; all start with `KEY_PREFIX`                            | a key shape drifting from the docs                           |
| Integration | `compose()` → `/health` reports `postgres: ok` and `redis: ok`; `close()` ends both                                                                    | the closure or the `quit` not wired                          |
| Smoke       | #1 now requires `redis: "ok"`                                                                                                                          | a running system without Redis                               |

**Concurrency:** N/A — nothing here touches inventory.

**How the tests will be proven able to fail:** remove the `error` listener and watch the kill test crash the runner; break a key shape; drop the `redis` closure from composition.

---

## 6. Risks and failure modes

- **What if Redis is down at boot?** `compose()` still returns: ioredis connects asynchronously, logs `error` and `reconnecting` on a loop, and `/health` answers 503 with `redis: "down"` within 2 s. The API serves `GET /events*` from Postgres as before. Verified by hand (decision 10).
- **What if Redis dies while running?** `error` logged, `reconnecting` logged with the delay, `ready` logged when it is back; commands issued meanwhile queue (decision 2). The process never exits — that is the acceptance line.
- **What if a key is evicted under `allkeys-lru`?** Nothing is stored yet. The local and compose servers run `noeviction` (checked: `maxmemory-policy noeviction`); TB-040 experiments with the others.
- **What if this operation runs twice?** `compose()` twice makes two clients (a test does this); `close()` twice is memoised.
- **What if it dies halfway through?** `quit()` on a client that never connected resolves; nothing is persisted.
- **An unhandled `error` event:** the one real risk, closed by the listener and proven by the kill test's sabotage.

---

## 7. Could Postgres already do this?

Yes, everything the system does today. This task adds nothing Postgres could not do because it adds no behaviour; it is the connection the next tasks need. The question is asked properly in TB-018 (cache: Postgres with the TB-013 index already answers in 23 ms — the cache must beat that honestly) and TB-022 (the live counter: `SELECT … FOR UPDATE` would serialise correctly too, and the ADR must say why Lua).

---

## 8. Open questions

None blocking. Decisions 2 (offline queue on) and 6 (hash tags) are the ones a reviewer may want argued the other way.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed; no alternative was rejected
- ☑ Task doc — `docs/tasks/TB-017-redis-client-and-keys.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
