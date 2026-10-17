# TB-022 — Lua-backed RedisHoldStore

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-022 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-022-lua-create-hold.md`](../implementation-plans/TB-022-lua-create-hold.md)
**Branch / PR:** `feat/TB-022-lua-create-hold` · [#26](https://github.com/Hanna-Hinn/Ticketbox/pull/26) (based on #25, the TB-021 write-up, which sits on #24)
**ADR:** [`docs/adr/0001-lua-over-watch.md`](../adr/0001-lua-over-watch.md) — dated and completed here; one line added to [`0002`](../adr/0002-live-count-wins-computed-count-is-the-fallback.md)

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

The read-decide-write that oversold 195 holds in TB-021 now runs as one Lua script, and the same 200-caller test sells exactly 10 tickets to exactly 5 callers, twenty runs out of twenty. `RedisHoldStore` is the first real `HoldStore`, wired into the composition root in place of the placeholder; `find` and `availability` read the hold hash and the live counters; `release` waits for TB-023's compare-and-restore. The `HoldStore.reserve` port now takes the `Hold` entity, so one clock — the use case's — sets the expiry the client counts down to, the sweeper's index score and the hold's own record.

---

## How it works

```
create_hold.lua  (KEYS: tier hash, hold hash, tier holds zset; ARGV: qty, token, tierId, createdAt, expiresAt, ttlMs)
  EXISTS hold         → 1: return the current remaining     (a replay of a lost reply: already paid)
  HGET tier remaining → nil: return -2                       (no counter: refuse, warn, reconcile)
  remaining < qty     → return -1                            (insufficient: nothing written)
  HINCRBY tier remaining -qty
  HSET hold tierId qty createdAt expiresAt
  PEXPIRE hold ttlMs                                         (Redis's clock, from now)
  ZADD tier:holds expiresAt token                            (the app's clock, the same instant the client sees)
  return the new remaining
```

Redis runs the script to completion before it looks at the next command from any client, so there is no gap for a second caller's read to land in. That is the whole fix: not speed (TB-021 showed ten connections oversell exactly as one does), but the absence of a round trip between the read and the write. Seven commands, no loop, well under a millisecond — the blocking is the guarantee.

The adapter maps the integers to the port's values (`-1` → `insufficient`; `-2` → `insufficient` plus a warn naming the tier), throws on a client that is not `ready` (fail closed on the write path, instead of waiting in ioredis's offline queue) and gives each write a 1 s deadline for the client that is connected and silent. `availability` is the fail-open side: not ready or past 100 ms → empty map → the computed count (ADR 0002). `find` rebuilds the entity from the hash with `Hold.create({ now: createdAt, ttlMs: expiresAt − createdAt })`, and treats a malformed hash as a bug.

The script is registered with ioredis's `defineCommand` in the adapter's constructor: the first call on each socket goes as `EVAL`, later ones as `EVALSHA`, and a `NOSCRIPT` reply (a restarted Redis) is resent as `EVAL` — read in `node_modules/ioredis/built/Script.js`, not assumed. The TypeScript side is a module augmentation of ioredis's `RedisCommander`, which is the opening its own typings leave for custom commands; it is global to the package, so the comment says to call `createHold` from the store and nowhere else.

### Layers touched

| Layer                                     | What changed                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| L1 `domain/**`                            | nothing                                                                                                                             |
| L2 `application/**`                       | `ports/HoldStore.ts`: `reserve(hold: Hold)`; `use-cases/CreateHold.ts` passes the hold it built                                     |
| L3 `infrastructure/**`, `presentation/**` | `redis/scripts.ts`, `redis/RedisHoldStore.ts` (new); `redis/within.ts` names the command; `system/UnconfiguredHoldStore.ts` deleted |
| L4 `main/**`, `worker/**`                 | `composition.ts`: `new RedisHoldStore(redis, log.child({ component: "hold-store" }))`                                               |
| repo root                                 | `scripts/lua/create_hold.lua`                                                                                                       |
| test fakes                                | `InMemoryHoldStore.reserve(hold)`; `aHold()` builder                                                                                |

### Key files

| File                                                                     | What it does                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `scripts/lua/create_hold.lua`                                            | the atomic reserve; its header is the race it prevents, in TB-021's numbers                               |
| `packages/api/src/infrastructure/redis/scripts.ts`                       | reads the `.lua` from the repo root, types `createHold`, defines it on a client                           |
| `packages/api/src/infrastructure/redis/RedisHoldStore.ts`                | the port over the script: fail-closed writes with a deadline, fail-open reads, `find` rebuilds the entity |
| `packages/api/test/integration/redis/RedisHoldStore.concurrency.test.ts` | the TB-021 test, kept, ×20                                                                                |

### Redis keys introduced

| Key                                | Type | TTL                     | Who writes it                                       | Who reads it                              |
| ---------------------------------- | ---- | ----------------------- | --------------------------------------------------- | ----------------------------------------- |
| `ticketbox:v1:tier:<tierId>`       | hash | none (the live counter) | `create_hold.lua` (`HINCRBY`); seeded by nobody yet | `availability`, the script                |
| `ticketbox:v1:hold:<token>`        | hash | `PEXPIRE ttlMs`         | `create_hold.lua`                                   | `find`; the script's replay guard; TB-023 |
| `ticketbox:v1:tier:<tierId>:holds` | zset | none                    | `create_hold.lua` (`ZADD` score = `expiresAt`)      | the sweeper (TB-026)                      |

All three were reserved in `keys.ts` by TB-017; this task is the first writer.

### Lua scripts introduced

| Script            | The race it prevents                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_hold.lua` | read-then-write across a round trip: 200 callers each read 10, each decrement, −390 (TB-021). Inside the script the read and the write are one step; the sixth caller reads 0 |

---

## 3. Where this diverged from the plan

| Planned                                                                                                                      | What actually happened                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6: "runs twice" = a bug, since tokens are never retried; the script not idempotent                                          | The transport retries. ioredis re-sends a command that was in flight when the socket dropped (`autoResendUnfulfilledCommands`, default on), so a script whose reply was lost runs again with the same token. The reviewer ran it twice: 10 → 6, one hold hash saying 2. The script now checks `EXISTS` on the hold key first and answers with the current count | Review Major 1. `within.ts` had documented the resend for the cache, where `GET` is idempotent; `reserve` was the one non-idempotent command in the system and had no guard. The plan reasoned about client retries and forgot the client library's own. |
| Decision 6: `reserve` throws on a dead **or hung** client                                                                    | The first commit only handled dead (the `status` guard). `reserve` and `find` now run under a 1 s deadline; `within` takes a `what` so the error says "reserve exceeded", not "cache command"                                                                                                                                                                   | Review Major 2. A connected, silent socket would have held `POST /holds` for minutes.                                                                                                                                                                    |
| An EVALSHA test: `SCRIPT EXISTS` after a reserve                                                                             | It passed on a warm server whether or not the adapter called the script; `SCRIPT FLUSH` in Arrange fixed it                                                                                                                                                                                                                                                     | Review Major 3. A test that cannot fail.                                                                                                                                                                                                                 |
| Decision 10: a new ADR 0004                                                                                                  | ADR 0001 already existed with a placeholder date; dated and completed                                                                                                                                                                                                                                                                                           | Found while listing `docs/adr/` after the plan was written.                                                                                                                                                                                              |
| `Number(count)` for the live counter                                                                                         | A non-numeric counter is skipped with a warn on the read path and makes `reserve` reject                                                                                                                                                                                                                                                                        | Review Minor: `NaN` would have reached the client as `remaining: null`. Two rules by path, both stated in the comment.                                                                                                                                   |
| The replay guard returned `tonumber(nil)` when the counter was gone or corrupt → `{ ok: true, remaining: null }` (re-review) | Major                                                                                                                                                                                                                                                                                                                                                           | The guard answers `-2` when the counter is missing or not a number; two tests (counter deleted / set to "ten" between the run and the replay)                                                                                                            |
| `HoldLifecycle.test.ts` in the file list                                                                                     | Untouched — it reaches `reserve` only through the use cases                                                                                                                                                                                                                                                                                                     | Listed from the grep of call sites without checking which were direct.                                                                                                                                                                                   |
| `fakes.test.ts`: the call sites of `reserve`                                                                                 | Six date literals were also folded into a `START` constant                                                                                                                                                                                                                                                                                                      | A collateral tidy-up in a file already touched; named here as the review asked.                                                                                                                                                                          |

The port change (decision 1) stood and earned its diff: it took the only clock out of L3, and it is what let the "score from `Date.now()`" sabotage go red at the integration level (the score must equal the hold's `expiresAt` from a fixed 2026-01-01 clock, which `now + ttl` can never produce).

---

## 4. Tests shipped

| Level       | Test file                                                   | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/application/use-cases/CreateHold.test.ts`        | the store receives the same hold the caller is told about (token, tier, qty, `expiresAt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Unit        | existing use-case, lifecycle and fake tests                 | unchanged behaviour through `reserve(hold)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Integration | `test/integration/redis/RedisHoldStore.test.ts`             | decrements and writes the hash (four fields) and the index (score = `expiresAt`); `PTTL` in (ttl − 100, ttl]; insufficient writes nothing (counter, hold key, index); exactly the remainder then refused; no counter → `insufficient` + warn naming the tier, nothing written; **a token sent twice pays once**; non-numeric counter → `reserve` rejects; `SCRIPT FLUSH` then `SCRIPT EXISTS` after a reserve; a disconnected client fails fast; **a connected silent client fails at the 1 s deadline**; `find` rebuilds the same instants; unknown → `null`; a 50 ms TTL — gone, counter not restored, index entry still there; a malformed hash throws; `availability` only seeded tiers; non-numeric counter skipped with a warn; empty map when not connected; `release` throws until TB-023 |
| Integration | `test/integration/main/composition.test.ts`                 | the live counter (7) overrides the cached count on `GET /events/:id`; the other tiers keep their computed count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Concurrency | `test/integration/redis/RedisHoldStore.concurrency.test.ts` | **200 × reserve(2) against 10 → exactly 5 ok whose replies are 8, 6, 4, 2, 0; counter "0"; 5 hold keys; 5 index members — ×20**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Smoke / E2E | —                                                           | unchanged; `POST /holds` stays a todo until the route exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Final run: typecheck clean, `lint --max-warnings 0` clean, unit **152 passed**, integration **125 passed** (13 files). CI green on `5622523`; `b3bed2b` is red by the restore mistake above and the commit after it is the one to read.

**Proven able to fail** — ten sabotages, seven run by the reviewer on `5622523`, three here on `7f33ca7`, each restored from git:

```
(reviewer)
1   adapter issues the TB-021 sequence instead of the script      concurrency ×20 red (20 failed)
1b  the same after SCRIPT FLUSH                                   + the EVALSHA test (21 failed)  ← why Major 3
2   `< qty` dropped in the Lua                                    22 red: concurrency ×20, insufficient, exactly-the-remainder
3   PEXPIRE dropped                                               2 red: TTL within tolerance, forgets the hold when its TTL elapses
4   ZADD dropped                                                  22 red: concurrency ×20, index entry, TTL elapses
5   ZADD with ttlMs as the score                                  1 red: decrements … index entry
6   -2 mapped to ok                                               1 red: refuses a tier with no counter
7   adapter passes Date.now() + ttl as expiresAt                  2 red: index entry, find rebuilds the same instants
(here)
8   replay guard removed from the Lua                             1 red: pays once for a token sent twice
9   reserve deadline 60 s                                         1 red: gives up on a connected client … (vitest timeout, 10 s)
10  adapter bypasses the script (naive sequence), after the fix    4 red in the store file (no-counter, replay, EVALSHA, deadline) + concurrency 20/20
11  replay guard back to `return tonumber(HGET …)`                 2 red: refuses a replay whose counter has gone missing / is no longer a number
```

Sabotage 11's restore (`git checkout -- create_hold.lua`) wiped the then-uncommitted fix before it was committed, so `b3bed2b` carried the two tests without the guard change; the commit after it carries both. Fourth time this repo's record shows "commit before you sabotage".

**Coverage after this task:** not measured — TB-042's gates. Every branch of the script has an integration test; the adapter's `release` is a throw.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It read ioredis's `Script.js`, `Commander.js`, `RedisCommander.d.ts` and `event_handler.js` rather than trusting the comments, ran seven sabotages, and wrote a node script that called the script twice with the same arguments to prove the double decrement.
**Verdict:** SAFE TO MERGE after Phase 4 — three Majors, all plan corrections, fixed in `7f33ca7` → re-reviewed on `5e058fc`: **SAFE TO MERGE**, one Major left in the replay guard itself (below), fixed with its tests in the final commits.

| Finding                                                                                                    | Severity | Resolution                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| ioredis re-sends an in-flight `createHold` after a reconnect; the script double-decrements under one token | Major    | `EXISTS` on the hold key first; plan §6 rewritten; header rewritten; test                        |
| "Throws on a hung client" promised, only "dead" delivered                                                  | Major    | 1 s deadline on `reserve` and `find`; `within(…, what)`; test with a never-settling `createHold` |
| The EVALSHA test cannot fail on a warm server                                                              | Major    | `SCRIPT FLUSH` in Arrange                                                                        |
| `Number(count)` → `NaN` → `remaining: null` on the wire                                                    | Minor    | Skipped with a warn on read; `reserve` rejects; both tested                                      |
| Header says "195 holds sold from 10 tickets"                                                               | Minor    | "200 holds written, 195 of them oversold"                                                        |
| The augmentation types `createHold` on every `Redis`                                                       | Minor    | Said in the comment                                                                              |
| `held()` thunk; lexical `.sort()`; `holdToken("*")` as a pattern; the warn fires per request; `START`      | Minor    | Thunk removed; comparator; noted in a comment; recorded below; recorded in §3                    |

Findings deliberately **not** fixed: the warn on a `-2` fires once per refused request (200 clicks on an unseeded tier = 200 lines) — acceptable until the counters are seeded, which is the next task's question; `keys.holdPattern()` is TB-040's.

---

## 6. Failure modes, as built

- **Redis down:** `reserve` and `find` throw at once (`redis is reconnecting; cannot reserve`) instead of queueing; `availability` answers the empty map and reads show the computed count. TB-039 maps the throw to a status code.
- **Redis connected but silent:** `reserve` and `find` reject at 1 s; `availability` at 100 ms. A reserve that timed out may still have run — a hold nobody holds, gone in 120 s, its tickets back when the sweeper runs (TB-026).
- **Reply lost, command re-sent:** the script sees the hold key and answers with the current count; nothing is paid twice. Tested with the same hold twice.
- **Key evicted under `allkeys-lru`:** the counter → `-2`, refused and logged — sold out until TB-027 reconciles. A hold hash → `find` is `null`, the countdown ends in `not-found`, and the tickets stay decremented until the sweeper finds an index entry whose key is gone. The index → those holds expire without ever being swept; TB-027 is the only way back. All three are TB-040's experiments.
- **Operation runs twice with a new token:** two holds, by design; the idempotent `POST /holds` is TB-030's.
- **Dies halfway through:** inside the script there is no halfway. Between the script and the caller, see "reply lost".
- **Clock skew** between the API host and Redis moves the key's death relative to the index score by the skew; TB-023 and TB-026 must be correct in either order.
- **A tier with no counter** — every tier, today: nothing seeds `tier:<id> remaining`. Every `POST /holds` will refuse with a warn until TB-023/TB-025/TB-027 decide who writes it.

---

## 7. What I'd do differently

Read `event_handler.js` before writing the "runs twice" answer. The plan reasoned about the client code (tokens are never reused) and forgot the client library — the one place a retry happens without anyone writing a retry. The resend was already documented in this repo, two files away, for a command where it did not matter.

---

## 8. Follow-ups left behind

- [ ] **Who seeds the live counters** (`tier:<id> remaining`)? Until something writes them, every reserve is refused. TB-023 (route), TB-025 (clicks) and TB-027 (reconcile) — one of them has to answer, deliberately.
- [ ] TB-023: `release_hold.lua`, compare-and-restore; `RedisHoldStore.release` throws until then. The replay guard means a release followed by a replayed reserve of the same token would pay again — the replay window is the reconnect, release is later; worth one sentence in TB-023's plan.
- [ ] TB-026: the sweeper must handle both orders of "hold key gone" and "index score passed" (clock skew), and an index entry whose key was evicted.
- [ ] TB-040: `keys.holdPattern()` for KEYS/SCAN inspection; the warn-per-request on an unseeded tier.
- [ ] The handbook's `test/concurrency/` directory has no runner; the concurrency test lives under `test/integration/` so CI runs it. A `test:concurrency` script when there is a second such file.
