# TB-017 — Redis client and key registry

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-017 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-017-redis-client-and-keys.md`](../implementation-plans/TB-017-redis-client-and-keys.md)
**Branch / PR:** `feat/TB-017-redis-client-and-keys` · [#20](https://github.com/Hanna-Hinn/Ticketbox/pull/20) (based on #19)
**ADR:** none — no alternative was rejected. The one real decision (how to close a client whose server is gone) is recorded below and in the plan.

---

## What this task delivered

Redis is in the system as a driver and nothing else. `createRedisClient(url, log)` returns one ioredis client with its five lifecycle events routed to pino; `closeRedisClient(client)` shuts it down in milliseconds whether Redis is there or not; `infrastructure/redis/keys.ts` is the only place a Redis key string is written, building three documented shapes from branded ids under `ticketbox:v1:`. The composition root creates the client, adds `redis` to `/health`, and closes it with the pool. Integration tests use DB index 9 with `FLUSHDB` per test and drive the "connection killed" case with `CLIENT KILL`.

---

## How it works

```
compose()
  createRedisClient(REDIS_URL, log.child({ component: "redis" }))      ← connects now, reconnects forever
     on connect / ready → info · error → error (name, message, stack, causes) · reconnecting → warn {delayMs} · end → info
  checks.redis = () => redis.ping()                                     ← pingWithin (TB-011) bounds it at 2 s
  close(): app.close() → Promise.all([pool.end(), closeRedisClient(redis)])

closeRedisClient(client)
  status "ready"  → quit()        waits for pending replies
  anything else   → disconnect()  clears the reconnect timer; returns at once

keys.tier(tierId)        ticketbox:v1:tier:<id>          hash { remaining }   (TB-022)
keys.tierHolds(tierId)   ticketbox:v1:tier:<id>:holds    zset token → expiresAt (TB-022/026)
keys.hold(token)         ticketbox:v1:hold:<token>       hash, the live hold  (TB-022)
```

Two mechanics worth keeping, both measured rather than believed:

- **ioredis never crashes on an unlistened `error`.** It `console.error`s and carries on. The listener exists so the line reaches pino, structured. What keeps the API usable while Redis is gone is the default retry strategy — `min(2^(n−1) × 50 ms, 5 s)` plus up to 200 ms jitter, forever — and what brings it back is the same loop.
- **`quit()` is only right while Redis answers.** While it is unreachable, every `/health` ping since the last `ready` sits in the offline queue, `quit()` queues behind them, and ioredis settles that queue only after `maxRetriesPerRequest` (20) reconnect attempts: 74 s measured, after which `quit()` rejects and the reconnect timer still keeps the process alive. `disconnect()` returns in under a millisecond. The status may still read `reconnecting` afterwards (no socket, so no close event), but nothing holds the event loop; a queued command either rejects or stays pending, and its caller's deadline has already settled it.

### Layers touched

| Layer                      | What changed                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| L1, L2                     | None                                                                                                                                 |
| L3 `infrastructure/redis/` | New: `client.ts` (`createRedisClient`, `closeRedisClient`), `keys.ts`                                                                |
| L4 `main/composition.ts`   | Client, `redis` health closure, close                                                                                                |
| tests                      | `support/redis.ts`; `integration/redis/client.test.ts` (6); `unit/infrastructure/redis/keys.test.ts` (3); composition (+1); smoke #1 |

### Key files

| File                                              | What it does                                            |
| ------------------------------------------------- | ------------------------------------------------------- |
| `packages/api/src/infrastructure/redis/client.ts` | The client, its logging, and the close that cannot hang |
| `packages/api/src/infrastructure/redis/keys.ts`   | The registry; `KEY_PREFIX` is module-private            |
| `packages/api/test/integration/support/redis.ts`  | `testRedisUrl()` (DB 9), `connectToTestRedis()`         |

### Redis keys introduced

| Key                            | Type | TTL   | Who writes it    | Who reads it   |
| ------------------------------ | ---- | ----- | ---------------- | -------------- |
| `ticketbox:v1:tier:<id>`       | hash | none  | TB-022 (not yet) | TB-022         |
| `ticketbox:v1:tier:<id>:holds` | zset | none  | TB-022 (not yet) | TB-026 sweeper |
| `ticketbox:v1:hold:<token>`    | hash | 120 s | TB-022 (not yet) | TB-022/023     |

Defined, not yet written to.

### Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                               | What actually happened                                                                                                                                                                                                                                                                | Why                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `close()` calls `quit()`                                                              | `closeRedisClient`: `quit()` only when `ready`, else `disconnect()`. The reviewer measured a plain `quit()` behind one queued ping at 74 s and a process that never exited; my hand drill's "exit in 2.5 s" had held only because the queue happened to be empty.                     | Review, Critical. The acceptance line is about Redis being gone; the shutdown path was broken exactly then. |
| §2: "an `error` event with no listener terminates the process"                        | False for ioredis (true for `pg.Pool`, where the sentence came from). The header and the composition comment say what the listener is for.                                                                                                                                            | Review, Critical.                                                                                           |
| Decision 3: retry default `min(times × 10, 1000)`, "read from the installed source"   | That is the _sentinel_ strategy on the same page; the client default is exponential with jitter. The claim of having read it was made after reading the wrong function. Recorded in the plan as such.                                                                                 | Review, Critical. The Prime Directive, violated by me while citing it.                                      |
| Decision 6: hash tags `tier:{id}` to stay cluster-valid                               | Dropped. The handbook says no cluster; the plan's braces were placeholder notation; and with the hold key untagged the tag bought nothing even in the hypothetical.                                                                                                                   | Review, Major.                                                                                              |
| Tests line: key builders tested as "integration"                                      | Pure functions, no Redis — a unit test by the handbook's definition, and it counts toward the `infrastructure/**` gate only there.                                                                                                                                                    | Review, Major.                                                                                              |
| Error log `{ err }`                                                                   | `{ name, message, stack, causes? }` — a reply error carries the failed command's args (`AUTH` → the password); and on a host where `localhost` has two address families a refused connection is an `AggregateError` with an empty message, which CI caught (the first head went red). | Review, Major; then CI.                                                                                     |
| §5: the kill test proves "the `error` listener was called"                            | A `CLIENT KILL` is a clean close: `close → reconnecting → connect → ready`, no `error` event. The listener is covered by the dead-port test. The kill test now counts one `reconnecting` and two `ready` lines.                                                                       | Review, Major.                                                                                              |
| `lazyConnect: false`, `end` at warn, `KEY_PREFIX` exported, a hand-rolled `once`      | Default restated; a clean `quit` logs `end`, so info; one tautological consumer; `node:events` has `once`.                                                                                                                                                                            | Review, Minor.                                                                                              |
| Decision 10's `await once(client, "end")` after `disconnect()` (tried during the fix) | Hangs: from `reconnecting` there is no socket, so no close event and no `end`. Removed; the process exiting is the evidence.                                                                                                                                                          | Measured during Phase 2 of the fix.                                                                         |
| —                                                                                     | Plan decisions 2, 4, 7, 9 held; 3, 6, 8 and the §2 premise did not. All were approved by blanket go-ahead and first challenged at review.                                                                                                                                             | Recorded, not smoothed over.                                                                                |

---

## 4. Tests shipped

| Level       | Test file                                     | Behaviour asserted                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/infrastructure/redis/keys.test.ts` | the three documented key shapes                                                                                                                                                                                                                                                                                                   |
| Integration | `test/integration/redis/client.test.ts`       | connects and pings; `set`/`get` round-trip; DB 9 is flushed per test; `CLIENT KILL` → `reconnecting`, a second `ready`, `ping` answers; a refused connection is logged with its reason (`ECONNREFUSED`, from `causes` on a two-family host) and never a `command`; close against a dead port with a queued ping resolves in < 1 s |
| Integration | `test/integration/main/composition.test.ts`   | `/health` reports both engines `ok`; with a dead `REDIS_URL`: 503 `{ postgres: ok, redis: down }` and `close()` in < 1 s                                                                                                                                                                                                          |
| Smoke       | `test/smoke/smoke.test.ts` #1                 | `/health` is `{ postgres: ok, redis: ok }` exactly                                                                                                                                                                                                                                                                                |

102 unit · 63 integration · smoke `4 passed | 2 todo` — observed green on the head; CI green on e0f65ba after the `AggregateError` fix (the head before it was red on the runner for exactly the reason the test now covers).

**Proven able to fail** — five sabotages, each restored from git, suites green after:

```
S1: retryStrategy: () => null                     1 failed — kill test timed out (never reconnects)
S2: error listener removed                        1 failed — "logs a connection error with its reason"
S3: closeRedisClient → plain quit()               2 failed — close-on-dead-port and composition degraded both timed out (10 s)
S4: a brace back in keys.tier                     1 failed — "builds the per-tier hash key" (unit)
S5: redis closure dropped from composition        2 failed — health with both engines; degraded health
```

**Acceptance drill, by hand against the local server:** Redis stopped under the running API → `/health` 503 `{"postgres":"ok","redis":"down"}` in 2.0 s, same pid alive, log `redis error` ×4 and `redis reconnecting` ×5 with delays; Redis started → `/health` 200, second `redis ready`, same pid. SIGTERM with Redis down → clean exit in 2.5 s — and, per the review, that number was luck (empty queue); the integration test is what now proves the shutdown.

**Coverage after this task:** `infrastructure/**` gains `keys.ts` under the unit runner; `client.ts` is integration-covered only, like the other adapters (TB-042).

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It read ioredis 6.0.0's built sources for every claim (`silentEmit`, `RedisOptions.js` defaults, `quit`'s offline-queue short-circuit, `DataHandler`'s `err.command`), measured `quit()` behind a queued ping (74 s), proved `CLIENT KILL` emits no `error`, traced the `AUTH` password into pino's serializer, and probed `closeRedisClient` from every status.
**Verdict:** NEEDS WORK → fixed → re-reviewed → **SAFE TO MERGE** pending Phase 4 (delivered)

| Finding                                                                                                                             | Severity | Resolution                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `close()` cannot finish while Redis is unreachable once `/health` ran                                                               | Critical | `closeRedisClient`; S3 and the two new tests                              |
| Header asserts two false ioredis semantics                                                                                          | Critical | Rewritten from the source; plan amended with the admission                |
| Hash tags justified by a scenario the handbook excludes                                                                             | Major    | Dropped                                                                   |
| Keys test filed as integration                                                                                                      | Major    | Moved to unit                                                             |
| An `error` line can carry the Redis password                                                                                        | Major    | `{ name, message, stack, causes? }`; regression test asserts no `command` |
| Kill test claims an `error` event; one assertion could not fail                                                                     | Major    | Counts two `ready` lines; plan §5 corrected                               |
| `lazyConnect: false`; `end` at warn; hand-rolled `once`; blanket `catch`; thunk; ordering-dependent flush test; `KEY_PREFIX` export | Minor    | All applied                                                               |
| Composition test's literal `redis://localhost:6379`                                                                                 | Minor    | Left — pre-existing, surgical                                             |
| "drops the queue" wording; `once` rejects on a prior `error`                                                                        | Note     | Comment reworded; one line in the test file                               |

Findings deliberately **not** fixed: the literal URL in the composition test.

---

## 6. Failure modes, as built

- **Redis down at boot:** `compose()` returns; `error`/`reconnecting` logged on a loop; `/health` 503 with `redis: "down"` in 2 s; reads from Postgres unaffected (tested through the real composition).
- **Redis dies while running:** logged, reconnects, second `ready` (tested with `CLIENT KILL`; drilled by hand with a real stop).
- **Shutdown while Redis is down:** `disconnect()`, returns at once, process exits (tested; S3 is the 74 s alternative).
- **Key evicted under `allkeys-lru`:** nothing stored yet; local and compose servers run `noeviction`.
- **Operation runs twice:** two `compose()`s are two clients; `close()` is memoised.
- **Dies halfway through:** nothing is persisted.
- **A password in the logs:** the `AUTH` reply error's `command.args` are not serialised (tested for the key, traced for the password).

---

## 7. What I'd do differently

Measure the shutdown path under the failure the acceptance line names, not under the happy path. The hand drill answered "does it exit?" once and I took the number as a property; the reviewer asked "with what in the queue?" and the answer changed by a factor of thirty.

---

## 8. Follow-ups left behind

- [ ] **TB-018:** `createRedisClient` is the client the cache takes; add the cache key to `keys.ts` there.
- [ ] **TB-022:** write the three keys; record that a `create_hold` script touching hold + tier keys is single-node by design.
- [ ] **TB-039:** decide fail-open vs fail-closed per endpoint; the offline queue (default on) is what makes that choice possible.
- [ ] **TB-040:** `SCAN MATCH ticketbox:v1:hold:*` needs a pattern builder in `keys.ts`, not a prefix export.
- [ ] **Composition test:** replace the literal `redis://localhost:6379` with `testRedisUrl()` when the file is next touched.
