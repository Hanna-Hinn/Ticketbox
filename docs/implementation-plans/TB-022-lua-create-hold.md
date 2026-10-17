# TB-022 — Lua-backed RedisHoldStore

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-022 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-022-lua-create-hold` (stacked on `spike/TB-021-prove-the-race`, docs-only, which sits on `feat/TB-020-hold-use-cases`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making" — **decision 1 changes a port signature** and is the one to read first.
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `scripts/lua/create_hold.lua` doing atomically: read remaining → return `-1` if insufficient → `HINCRBY` availability down → `HSET` the hold hash → `PEXPIRE` 120s → `ZADD` the token to the tier's expiry index. Registered via `defineCommand`. `RedisHoldStore implements HoldStore`. A header comment on the script explaining precisely which race it prevents.

**Acceptance:** the TB-021 concurrency test now passes with exact numbers.

**Tests:** **integration** — the script decrements correctly; refuses when insufficient; sets the TTL within tolerance; adds to the ZSET. **Concurrency** — 200 parallel requests for 10 tickets: exactly 5 succeed (2 each), final availability is exactly 0, never negative. Run it 20 times in a loop; a concurrency test that passes once proves nothing.

**Depends on:** TB-021 — in the stack below this branch (nothing is merged by the session's instruction): ☑ (NOTES.md entry, −390)

---

## 2. What I understand this to mean

Move the read-decide-write of TB-021 into one Lua script so no other client can run between the read and the write, wrap it in the first real `HoldStore`, wire it into the composition root in place of the placeholder, and prove with the exact test that oversold by 195 that it now sells exactly 10 tickets to exactly 5 callers, twenty times in a row. `release` is TB-023's script; `find` and `availability` are plain reads and belong here because the port has them and the lifecycle (TB-020) needs them against Redis.

---

## 3. Approach

### Layers touched

| Layer                  | What changes                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`         | nothing (`Hold.create` reconstitutes a hold from its stored instants)                                                                           |
| L2 `application/**`    | `HoldStore.reserve` takes the `Hold` entity (decision 1); `CreateHold` passes the hold it already built                                         |
| L3 `infrastructure/**` | `redis/scripts.ts` (loads the `.lua` files, names them, types them), `redis/RedisHoldStore.ts` (new); `system/UnconfiguredHoldStore.ts` deleted |
| L4 `main/**`           | `composition.ts` wires `RedisHoldStore(redis, log)` where the placeholder was                                                                   |
| repo root              | `scripts/lua/create_hold.lua` — the handbook's fixed tree puts Lua at the root, beside `docs/`                                                  |
| test fakes             | `InMemoryHoldStore.reserve(hold)` stores what it is given (and loses the `Quantity.of` it had to call); `aHold()` builder                       |

### The script

```
create_hold.lua
  KEYS[1] tier hash        ticketbox:v1:tier:<tierId>            { remaining }
  KEYS[2] hold hash        ticketbox:v1:hold:<token>             { tierId, qty, createdAt, expiresAt }
  KEYS[3] tier holds zset  ticketbox:v1:tier:<tierId>:holds      token → expiresAt (ms)
  ARGV[1] qty   ARGV[2] token   ARGV[3] tierId   ARGV[4] createdAt (ms)   ARGV[5] expiresAt (ms)   ARGV[6] ttlMs

  local remaining = redis.call('HGET', KEYS[1], 'remaining')
  if not remaining then return -2 end                -- no counter: never seeded, or lost (decision 3)
  if tonumber(remaining) < tonumber(ARGV[1]) then return -1 end
  local left = redis.call('HINCRBY', KEYS[1], 'remaining', -ARGV[1])
  redis.call('HSET', KEYS[2], 'tierId', ARGV[3], 'qty', ARGV[1], 'createdAt', ARGV[4], 'expiresAt', ARGV[5])
  redis.call('PEXPIRE', KEYS[2], ARGV[6])
  redis.call('ZADD', KEYS[3], ARGV[5], ARGV[2])
  return left
```

Return contract: `≥ 0` the new remaining (reserved); `-1` insufficient (nothing written); `-2` no counter (nothing written). No loop, six commands, well under a millisecond.

**The race it prevents (the header comment):** TB-021 showed 200 callers each `HGET` 10, each pass the check in TypeScript, each `HINCRBY −2`: −390. The gap was the round trip between the read and the write — on the client, an event-loop turn; on the server, time enough to answer 199 other reads. Inside one script there is no gap: Redis runs the script to completion before it looks at the next command from anyone, so the read, the comparison and the decrement are one indivisible step and the 6th caller reads 0, not 10.

### Decisions this plan is making

1. **`reserve` takes the `Hold` entity, not `(tierId, qty, token, ttlMs)`.** The script needs the absolute `expiresAt` for the ZSET score (the sweeper's index) and for the hold hash (what `find` gives back to `GetHold`), and the relative `ttlMs` for `PEXPIRE`. The use case already built a `Hold` with both instants from its injected `Clock`; passing the entity means **one clock** sets the expiry the client counts down from, the score the sweeper sorts by, and the hold's own `expiresAt` — TB-007's open question ("name which clock the ZSET score comes from") answered: the application's `Clock`, never `Date.now()` in the adapter. The key's TTL is the one thing on Redis's clock (`PEXPIRE ttlMs` from the moment the script runs, as the Scope line says); within clock skew it agrees with the score, and TB-023/TB-026 must be correct in either order of "key gone" vs "score passed" anyway. Cost: a port signature change touching `CreateHold`, the fake and five test files — listed in §4, all mechanical. `HoldRepository.save(hold)` already crosses the same port shape with the same entity.
2. **`-1` / `-2` / `≥ 0` as the script's return, mapped in the adapter.** The port's result is unchanged: `{ ok: false, reason: "insufficient" }` for `-1`. Lua cannot return a structured reply without encoding one; integers are the honest contract and the adapter is the only reader.
3. **A missing counter refuses, loudly.** `-2` maps to `insufficient` at the port (the fake has answered that for an unseeded tier since TB-008), **and the adapter logs a warn naming the tier** ("no live counter; reconcile"). ADR 0002 admitted "nothing logs the disagreement" between reads (computed fallback) and writes (refuse); from this task the write side logs it. Not seed-and-proceed: seeding from Postgres inside a Redis adapter would cross two adapters, and the number to seed is the TB-010 query — reconciliation's job (TB-027), done deliberately. ADR 0002 gets one line under "what would make us revisit".
4. **`release` throws "not implemented until TB-023"** rather than a half-correct `DEL`. The port requires the method; the only correct implementation is the compare-and-restore script, which is the next task's whole lesson. `ReleaseHoldUseCase` has no route until TB-023, so nothing reaches it.
5. **`find` reads the hold hash and rebuilds the entity with `Hold.create({ now: createdAt, ttlMs: expiresAt − createdAt })`** — no new L1 factory; the stored instants reproduce the same expiry. A missing key (expired, never existed, evicted) is `null`. A hash with a missing or non-numeric field throws: it is our own write and nothing else writes it, so a malformed one is a bug, not a value — unlike the event cache, which a hand edit in RedisInsight was expected to corrupt.
6. **Reads fail open, writes fail closed.** `availability` follows the cache's guard: client not `ready` → empty map (the ADR 0002 fallback shows the computed count), and each `HGET` under the 100 ms deadline from `within.ts` → on failure, empty map + warn. `reserve` and `find` throw on a dead or hung client: a `POST /holds` that cannot reach the store is an error (TB-039 decides the status code), never a silent "insufficient". This keeps `GET /events/:id` exactly as available as it was with the placeholder. _(amended in review)_ "Hung" was promised and not delivered by the first commit — the status guard sees a disconnected client, not a connected silent one. `reserve` and `find` now run under a 1 s deadline (`within`, which gained a `what` argument so the error names the command, not "cache"); a timed-out reserve may still have run, which is the lost-reply case in §6. A non-numeric counter is skipped with a warn on the read path (fail open, like an unparseable cache entry) and makes `reserve` reject (the script's comparison raises).
7. **The script is defined on the client by the adapter's constructor** (`redis.defineCommand("createHold", { numberOfKeys: 3, lua })`), so a `RedisHoldStore` is usable on any client it is handed and the integration test needs no extra step. `scripts.ts` owns reading `scripts/lua/*.lua` from disk (`readFileSync` on a URL relative to `import.meta.url`, the way the migration runner finds `migrations/`) and the TypeScript side of `defineCommand`: ioredis adds the method at runtime only, so the typed wrapper is a module augmentation of ioredis's `RedisCommander` interface — the mechanism its own typings provide for custom commands — verified by `pnpm typecheck`, not assumed. `EVALSHA` with the `NOSCRIPT` fallback is ioredis's `Script` class, read in `node_modules/ioredis/built/Script.js`: first call per socket is `EVAL`, later ones `EVALSHA`, and a `NOSCRIPT` reply resends as `EVAL`.
8. **The concurrency test is the TB-021 test, kept.** Same shape (`Promise.all` of 200 `reserve` of 2 against 10), asserting exactly 5 successes, remaining exactly 0, 5 hold keys, 5 ZSET members, **never negative** (asserted at the end and also by checking the script's return is never below 0), `it.each` over 20 runs, in `test/integration/redis/` so `pnpm test:integration` and CI run it. The handbook's tree has `test/concurrency/`; no runner or script points there yet, and a test that no command runs is not a test — a `test:concurrency` script is a decision for when there is more than one such file.
9. **The live counter is not seeded by this task.** After this PR, `POST /holds` (TB-023/TB-025's route) will refuse every tier until something writes `tier:<id> remaining`. Who does — TB-027's reconcile, or the seed script — is an open question raised in §8 for TB-023/TB-025, not solved here by a side effect.
10. **ADR 0001 — Lua over `WATCH`/`MULTI` — already exists** with a placeholder date ("fill in when you actually make this decision in TB-022"). _(amended before coding)_ The plan's first draft said ADR 0004; there is nothing to add but the date, the measured numbers and the replay guard. Amended in Phase 5, no new ADR.

### New or changed ports

```ts
// application/ports/HoldStore.ts
/** Atomically reserve hold.qty from hold.tierId under hold.token, expiring at hold.expiresAt. */
reserve(hold: Hold): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }>;
```

Fake: `InMemoryHoldStore.reserve(hold)` stores the entity it is given; the duplicate-token guard and the counter arithmetic stay. Builder: `aHold().withToken("tok-1").forTier(TIER).withQty(2).createdAt("2026-01-01T10:00:00.000Z").withTtl(120_000).build()`.

### Redis keys

All three already exist in `keys.ts` (reserved for this task in TB-017): `tier(id)` hash `{ remaining }` (no TTL — the live counter), `hold(token)` hash (TTL = the hold's), `tierHolds(id)` zset (no TTL; members leave when released or swept). The hold hash gains its field list in the comment.

### Lua scripts

`scripts/lua/create_hold.lua` — above. One script. Loaded by `infrastructure/redis/scripts.ts`.

### Migrations

None.

---

## 4. Files

| File                                                                                                                | New / Changed | Why                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `scripts/lua/create_hold.lua`                                                                                       | New           | the script, with its header comment                                                    |
| `packages/api/src/infrastructure/redis/scripts.ts`                                                                  | New           | reads the `.lua` files, declares the command names and their TypeScript signatures     |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`                                                           | New           | `HoldStore` over Redis: `reserve` (script), `find`, `availability`, `release` (TB-023) |
| `packages/api/src/infrastructure/redis/keys.ts`                                                                     | Changed       | comment only: the hold hash's fields                                                   |
| `packages/api/src/application/ports/HoldStore.ts`                                                                   | Changed       | decision 1                                                                             |
| `packages/api/src/application/use-cases/CreateHold.ts`                                                              | Changed       | passes `hold`                                                                          |
| `packages/api/src/infrastructure/system/UnconfiguredHoldStore.ts`                                                   | Deleted       | its job is done (TB-012 follow-up)                                                     |
| `packages/api/src/main/composition.ts`                                                                              | Changed       | `new RedisHoldStore(redis, log.child(…))`                                              |
| `packages/api/test/fakes/InMemoryHoldStore.ts`, `builders.ts`                                                       | Changed       | `reserve(hold)`; `aHold()`                                                             |
| `packages/api/test/unit/{fakes/fakes,application/use-cases/{CreateHold,GetHold,ReleaseHold,HoldLifecycle}}.test.ts` | Changed       | the call sites of `reserve`                                                            |
| `packages/api/test/integration/redis/RedisHoldStore.test.ts`                                                        | New           | the Tests line's integration cases                                                     |
| `packages/api/test/integration/redis/RedisHoldStore.concurrency.test.ts`                                            | New           | the TB-021 test, ×20                                                                   |
| `packages/api/test/integration/main/composition.test.ts`                                                            | Changed       | the live counter overrides the cached count (TB-018 follow-up); the store is wired     |
| `docs/adr/0001-lua-over-watch.md`                                                                                   | Changed       | decision 10 (amended): date, the numbers, the replay guard                             |
| `docs/adr/0002-live-count-wins.md` (whatever its exact name)                                                        | Changed       | one line: the write side now logs a missing counter                                    |
| `docs/BENCHMARKS.md`                                                                                                | Changed       | §7 Lua row                                                                             |
| `docs/tasks/TB-007-ports.md`, `TB-008-…`, `TB-012-…`, `TB-018-…`                                                    | Changed       | tick the follow-ups this task closes                                                   |

---

## 5. Test plan

| Level       | Test                                                                                                                                                                                                              | What it would catch                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Unit        | `CreateHold`, `GetHold`, `ReleaseHold`, lifecycle, fakes — unchanged behaviour through the new `reserve(hold)` signature                                                                                          | the port change breaking a use case                             |
| Unit        | `CreateHold` passes the hold it built: the store receives the same token, tier, qty and `expiresAt` the caller is told                                                                                            | the entity and the store disagreeing on the expiry              |
| Integration | the script decrements: `remaining` 10 → 8, returns 8; hold hash has the four fields; ZSET member = token with score = `expiresAt` ms; `PTTL` of the hold in `(ttlMs − 100, ttlMs]`                                | the Tests line                                                  |
| Integration | refuses when insufficient: 1 left, reserve 2 → `insufficient`, counter still 1, **no hold key, no ZSET member**                                                                                                   | a refusal that writes anyway                                    |
| Integration | reserve of exactly the remainder leaves 0 and succeeds; the next one is refused                                                                                                                                   | an off-by-one in the comparison                                 |
| Integration | no counter key → `insufficient` and a warn naming the tier; nothing written                                                                                                                                       | decision 3                                                      |
| Integration | `find` round-trips token, tier, qty, `expiresAt`; `find` of an unknown token is `null`; a 50 ms real TTL — `find` is `null` after it (the one place a real wait is allowed, by polling `PTTL`/`EXISTS`, no sleep) | the hash fields; expiry as absence                              |
| Integration | `availability` returns only seeded tiers; with the client not ready, an empty map                                                                                                                                 | ADR 0002's fallback regressing                                  |
| Integration | `release` throws until TB-023                                                                                                                                                                                     | someone shipping a `DEL`                                        |
| Integration | composition: a tier whose counter says 7 shows 7 on `GET /events/:id` while the cached event says 10                                                                                                              | the live count not overriding the cached one (TB-018 follow-up) |
| Concurrency | **200 parallel `reserve` of 2 against 10: exactly 5 ok, remaining exactly 0, 5 hold keys, 5 ZSET members, no script return below 0 — ×20**                                                                        | the stampede; the Acceptance line                               |
| Smoke / E2E | unchanged (`POST /holds` stays a todo until the route exists)                                                                                                                                                     |                                                                 |

**Concurrency:** yes — the assertion above, and it must be seen red with the script replaced by the TB-021 sequence before it is trusted.

**How each test will be proven able to fail:** replace the script body with `HGET` → compare → `HINCRBY` issued as three client commands (the TB-021 store) — the concurrency test must go red with the −390; drop the `< qty` check in Lua (insufficient test red, concurrency red); drop the `PEXPIRE` (TTL test red); drop the `ZADD` (ZSET test red); pass `ttlMs` where `expiresAt` goes (score test red); map `-2` to `ok` (missing-counter test red); make the adapter call `Date.now()` for the score (the `CreateHold` unit test comparing the store's `expiresAt` with the caller's cannot catch this against the fake — the integration score test with a `FakeClock`-built hold can: the score must equal the hold's `expiresAt`, not "now + ttl").

---

## 6. Risks and failure modes

- **What if Redis is down?** `reserve` throws (the client is not `ready` → ioredis queues or rejects; the adapter guards on status and throws a plain error so the request fails fast rather than waiting out the offline queue); `find` throws; `availability` returns the empty map and reads fall back to the computed count. TB-039 maps the throw to 503.
- **What if a key is evicted under `allkeys-lru`?** The counter: `-2`, refused, logged — a sold-out tier until reconciled (TB-027), which is the admitted eviction failure mode of ADR 0002, now visible in the log. A hold hash: `find` → `null`, the client's countdown ends in `not-found`, and its tickets stay decremented until the sweeper finds the ZSET member whose hold key is gone (TB-026's job to handle). A ZSET: the sweeper never sees those holds; their keys still expire; their tickets are never restored until reconcile. All three are TB-040's experiments.
- **What if this operation runs twice?** _(amended in review)_ It does, without any bug: ioredis re-sends a command that was in flight when the socket dropped (`autoResendUnfulfilledCommands`, the default; `event_handler.js` moves unanswered commands to a queue and re-sends them on reconnect), so a script that ran but whose reply was lost runs again with the same arguments. The first draft of this answer said "a repeat is a bug, not a retry" and the reviewer proved it double-decrements (10 → 6 under one token). The script is now idempotent per token: `EXISTS` on the hold key first — the token's receipt — and a replay answers with the current count instead of paying again. A client retry with a _new_ token is TB-030's idempotent `POST /holds`. Stated in the script's header.
- **What if it dies halfway through?** Inside the script there is no halfway — Redis runs it to the end or (on a crash before the write) not at all. Between the script and the caller: the reply can be lost after the script ran; the hold then exists with no one holding its token, and expires on its own in 120 s with the sweeper restoring it. That is the window TB-024's mirror does not cover either, and it is bounded by the TTL.
- **Clock skew** between the API host and Redis moves the key's death relative to the score (decision 1). Bounded by the skew; TB-023 and TB-026 must tolerate either order.

---

## 7. Could Postgres already do this?

Yes: `UPDATE tiers SET remaining = remaining − $1 WHERE id = $2 AND remaining ≥ $1 RETURNING remaining` is atomic under row locking, and a `holds` row with `expires_at` plus a `WHERE expires_at > now()` is a hold with a TTL. That is a perfectly good design for this load (TB-013: 310 req/s without any cache). It costs a row lock per reserve on the hottest row in the system — every buyer of one tier serialises on it — and a sweeper that polls `expires_at`. Redis gives the same atomicity without the lock (single-threaded, so there is nothing to lock) and the TTL as a primitive; the project exists to learn exactly that trade, and ADR 0004 says both halves.

---

## 8. Open questions

None blocking for this task. Two for the next ones:

1. **Who seeds `tier:<id> remaining` before TB-027?** Until something writes it, every `POST /holds` refuses with a warn. TB-023 adds the route and TB-025 needs clicks to work; one of them, or the seed script, has to write the counters (the TB-010 query gives the number). Decision 3 refuses to do it as a side effect here.
2. Decision 1 is a port change made for one-clock honesty; the alternative is `Date.now()` in the adapter and two clocks. A reviewer may prefer the smaller diff.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0001-lua-over-watch.md`, dated and completed (not a new one)
- ☑ Task doc — `docs/tasks/TB-022-lua-create-hold.md`
- ☑ Benchmark entry — `docs/BENCHMARKS.md` §7, the Lua row
- ☐ NOTES entry — not a SPIKE task
