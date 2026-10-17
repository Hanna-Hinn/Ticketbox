# TB-018 — CachedEventRepository decorator

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-018 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-018-cached-event-repository.md`](../implementation-plans/TB-018-cached-event-repository.md)
**Branch / PR:** `feat/TB-018-cached-event-repository` · [#21](https://github.com/Hanna-Hinn/Ticketbox/pull/21) (based on #20)
**ADR:** [`docs/adr/0003-cache-aside-over-write-through.md`](../adr/0003-cache-aside-over-write-through.md)

---

## What this task delivered

`GET /events/:id` reads from Redis after its first read, and nothing above L3 knows. `CachedEventRepository` wraps `PgEventRepository` behind the same `EventRepository` port: a miss reads through and writes the event as JSON with a 300 s TTL; a hit never touches Postgres; the bytes that come back are parsed through a Zod schema strict enough that an accepted payload cannot fail the domain constructors, and a rejected one is a miss, logged, never a 500. The acceptance line held: `git diff --stat` on `presentation/` and `application/` is empty.

The part that was not in the Scope line, and turned out to be the task's real content: a cache in front of a Redis whose offline queue is on can **hang** a read, not just miss. The decorator skips Redis while the client is not `ready` and runs every cache command under a 100 ms deadline; `invalidate` is fail-closed and bounded.

---

## How it works

```
findById(id)
  status !== "ready"            → inner.findById(id)                              never queue behind a reconnect
  within(GET cache:event:<id>, 100 ms)
    hit, schema accepts          → Event.create(…)                                 no Postgres
    hit, schema rejects / not JSON → warn (key, issue paths; never the payload) → miss
    miss                         → inner.findById(id)
                                     null  → return null, cache nothing           (negative caching: TB-019)
                                     event → within(SET … EX 300, 100 ms) → return event
  GET/SET throws or exceeds 100 ms → warn, continue as a miss                      the dangling command settles on its own

listUpcoming(now)                → inner.listUpcoming(now)                         a query over time: not cached

invalidate(id)                   → status !== "ready" → throw;  within(DEL, 100 ms) → throw on timeout
                                    (fail-closed: a swallowed DEL serves the old row for 300 s; a hung one is not fail-closed)
```

Why both the guard and the deadline: the guard is free and known before a command is issued, so a read while Redis is known-down pays nothing. But a command already on the wire when the socket dies is **re-sent** by ioredis after the reconnect (`autoResendUnfulfilledCommands`, default on) and rejected only after `maxRetriesPerRequest` attempts — ~74 s with TB-017's defaults. The reviewer reproduced it through a killing TCP proxy. No `try/catch` sees that; only a deadline settles it. The deadline is 100 ms because a healthy local `GET` is ~1 ms and the fallback (Postgres, indexed) ~23 ms — a cache read slower than its fallback has stopped being one.

### Layers touched

| Layer                      | What changed                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| L1, L2, `presentation/`    | **None** (the acceptance line; `git diff --stat` empty)                                                  |
| L3 `infrastructure/redis/` | New `CachedEventRepository.ts`; `keys.eventCache`; `describeRedisError` exported from `client.ts`        |
| L4 `main/composition.ts`   | `events = new CachedEventRepository(new PgEventRepository(pool), redis, log)` — the only line that knows |
| tests                      | `fakes/InMemoryCache.ts`; 15 unit, 4 integration, +1 through the composition root                        |

### Key files

| File                                                             | What it does                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/api/src/infrastructure/redis/CachedEventRepository.ts` | The decorator, the schema, `within`, `CACHE_TTL_SECONDS`, `CACHE_COMMAND_DEADLINE_MS` |
| `packages/api/test/fakes/InMemoryCache.ts`                       | `CacheClient` on a `Map`: settable `status`, `failing`, `hanging`                     |
| `docs/adr/0003-cache-aside-over-write-through.md`                | Cache-aside over write-through; bounded fail-open; fail-closed invalidation           |

### Redis keys introduced

| Key                                  | Type   | TTL   | Who writes it           | Who reads it  |
| ------------------------------------ | ------ | ----- | ----------------------- | ------------- |
| `ticketbox:v1:cache:event:<eventId>` | string | 300 s | the decorator on a miss | the decorator |

### Lua scripts introduced

None.

---

## 3. Where this diverged from the plan

| Planned                                                                                                        | What actually happened                                                                                                                                                                                                                                                                                    | Why                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Decision 6: "if a cache command throws, treat it as a miss"; §6: "the in-flight `GET` rejects (socket closed)" | It does not reject. ioredis re-sends it after the reconnect and rejects it after ~74 s. The `status` guard covers the _next_ request, not the one on the wire. Every cache command now runs under `within(…, 100 ms)`.                                                                                    | Review, Critical. The ADR had claimed a mechanism the driver does not have. |
| `invalidate` = `await del(key)`                                                                                | No guard, no bound: while Redis was down it would sit in the offline queue ~74 s. Now: not `ready` throws; the `DEL` runs under the deadline and a timeout propagates. The ADR also says _when_ the eventual hook fires (after the Postgres commit) and _where_ (the decorator's own `save`, never L2).   | Review, Major.                                                              |
| §5: the composition test counts Postgres queries through a `pg` spy                                            | No spy; the proof is a hand-edited cached JSON whose bytes only Redis holds coming back from the second `GET /events/:id`. Honest, and coupled only to `name` being a top-level field, which the schema already makes a contract.                                                                         | Review, Major — the plan described a test that did not exist.               |
| Composition test depended on the two tests before it; `composition.test.ts` not in §4                          | `beforeEach`: `flushdb` + `waitForReady()` (polls `/health` for `redis: ok`); the cache test passes alone. The second `testRedisUrl()` swap (the "closes idempotently" system) was a drive-by: it pointed a composed system at DB 0 while the suite flushes 9. Both in §4 now.                            | Review, Major.                                                              |
| `readonly status: string`                                                                                      | `RedisStatus` from ioredis, on the seam and the fake: a typo in a test is a compile error, not a passing "not ready".                                                                                                                                                                                     | Review, Minor.                                                              |
| A second `describe(err)` helper                                                                                | `describeRedisError` exported from `client.ts` and reused; the local one only maps a non-`Error` throw onto it.                                                                                                                                                                                           | Review, Minor (DRY).                                                        |
| "Skipping the write when not ready is harmless"                                                                | It is not optional: an awaited `SET` during a reconnect would hold the response. The comment says so.                                                                                                                                                                                                     | Review, Minor.                                                              |
| —                                                                                                              | `z.int()` loosened to `z.number()` broke **no** original test; five schema-shaped, constructor-hostile payload rows were added (2^53 cents, 1.5 remaining, −0.5 total, 2026-02-30, a `+01:00` offset). S5 below shows the loosened schema surfacing as an `InvalidMoney` throw — the 500 path they guard. | Review, Test Phase.                                                         |
| —                                                                                                              | A unit test for the read-hang timed out on first run: after the read's deadline the write-back hangs too and needs a second deadline. The test advances the fake clock once per command, and says why.                                                                                                    | Test bug; the fix documents both deadlines.                                 |
| —                                                                                                              | The docs script that amended the ADR aborted on a prettier-widened table row after writing the plan; the ADR amendments landed in a third commit after the re-review request had described them as present. Corrected to the reviewer at once.                                                            | Process. Same failure as TB-013/TB-016; row matching by regex from now on.  |
| —                                                                                                              | Plan decisions 1–3, 5, 7–10 held; 4 and 6 did not as written. All were approved by blanket go-ahead and first challenged at review.                                                                                                                                                                       | Recorded, not smoothed over.                                                |

---

## 4. Tests shipped

| Level       | Test file                                                      | Behaviour asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/infrastructure/redis/CachedEventRepository.test.ts` | miss then hit, inner called once; every field round-trips; 300 s TTL; nine corrupt or hostile payloads are misses and are healed; unknown id not cached; not-ready skips the cache; a throwing command reads through; a never-settling read reads through within the deadline; a never-settling write still returns the event; `invalidate` refuses when not ready; a never-settling `invalidate` fails at the deadline; null + corrupt key → null, key untouched; `listUpcoming` untouched; read-through after `invalidate` |
| Unit        | `test/unit/infrastructure/redis/keys.test.ts`                  | the cache key's shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Integration | `test/integration/redis/CachedEventRepository.test.ts`         | key exists with `PTTL` in (295 s, 300 s]; the second read comes from Redis (hand-edited name); invalidation removes the key; a corrupt entry is read through and rewritten                                                                                                                                                                                                                                                                                                                                                   |
| Integration | `test/integration/main/composition.test.ts`                    | through `compose()`: the second `GET /events/:id` returns the hand-edited cached name; tests own their state (`flushdb` + readiness per test)                                                                                                                                                                                                                                                                                                                                                                                |

125 api unit · 68 integration · smoke unchanged — observed green; CI green on every head.

**Proven able to fail** — seven sabotages, each restored from git, suites green after:

```
S1: no deadline on the GET                 1 failed — read never settles: timed out (would hang in production)
S2: no deadline on the SET                 2 failed — write never settles; and the read-hang test (its write-back)
S3: no deadline on the DEL                 1 failed — invalidation never settles: timed out
S4: invalidate without the status check    1 failed — "refuses to invalidate while not ready"
S5: z.int() → z.number()                   1 failed — InvalidMoney: cents must be a non-negative safe integer, got 9007199254740992  (the 500 path)
S6: z.iso.datetime() → z.string()          2 failed — calendar-impossible date; date with an offset
S7: SET with EX 0 (no usable TTL)          3 failed — TTL test; second read from cache; corrupt entry healed   (integration)
```

**Known trade-off, recorded for a future flake:** the two "second read comes from Redis" tests depend on a real `GET` answering inside the 100 ms deadline. On a loaded CI runner that could occasionally miss, in which case the read falls back to Postgres and the test fails on `name`. If it ever flakes, the _test_ moves (assert through a spy on the inner repository), not the constant.

**Coverage after this task:** `infrastructure/**` gains `CachedEventRepository.ts` under the unit runner (every branch has a unit test); `client.ts` remains integration-only.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It read ioredis's `event_handler.js` for the resend path and reproduced the in-flight hang through a killing TCP proxy; verified Zod 4's `z.int()` is `isSafeInteger` and `z.iso.datetime()` rejects calendar-impossible dates and offsets; checked the `set` overloads against the structural seam; and ran the composition cache test alone.
**Verdict:** NEEDS WORK → fixed → re-reviewed (typecheck, lint, unit, integration and the isolated test re-run on `5500051`) → **SAFE TO MERGE**

| Finding                                                                                          | Severity | Resolution                                                                     |
| ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------ |
| An in-flight cache command is re-sent, not rejected; the read hangs ~74 s                        | Critical | `within(…, 100 ms)` on GET, SET and DEL; ADR and plan corrected                |
| `invalidate` has no failure behaviour (would hang) and the ADR names the wrong layer as the hook | Major    | Fail-closed, bounded; ADR: the decorator's own `save`, DEL after commit        |
| Plan claimed a `pg` spy; the test hand-edits the JSON; test depended on ordering                 | Major    | Divergence recorded; `beforeEach` flush + readiness                            |
| `composition.test.ts` missing from the plan; second URL swap a drive-by                          | Major    | Both recorded in §4                                                            |
| `status: string`; duplicated `describe`; TTL restated in a comment; write-guard reason           | Minor    | All applied                                                                    |
| Cache key uses the caller's spelling of the id; corrupt key + missing event never heals          | Minor    | Recorded in the ADR; the fix for the first is in `presentation/`, out of scope |
| Deadline vs CI load; monkey-patched `get` in one test; blanket approval                          | Note     | Recorded here; cosmetic; recorded here                                         |

Findings deliberately **not** fixed: the uppercase-id normalisation (out of scope by the acceptance line); the monkey-patch in one unit test.

---

## 6. Failure modes, as built

- **Redis down before the request:** guard → read through; no cache command issued; ~23 ms from Postgres (unit-tested; the real composition's `/health` reports it).
- **Redis dies with a cache command on the wire:** at most 100 ms, then read through (unit-tested with a never-settling fake; reproduced for real by the reviewer).
- **Redis slow:** a `GET` over 100 ms is a miss; the cache degrades to Postgres rather than adding latency.
- **Key evicted under `allkeys-lru`:** a miss by design — the one key family where eviction is harmless.
- **Operation runs twice:** two concurrent misses both read Postgres and both `SET` the same bytes (the stampede TB-019 closes).
- **Dies halfway through:** between read-through and `SET`, nothing cached; between `SET` and return, cached and correct.
- **A corrupt entry:** a miss, warned with the key and issue paths, rewritten on the next successful read-through; if its event no longer exists in Postgres it is never rewritten and warns until its TTL expires.
- **Stale data:** up to 300 s after any change to an event; nothing changes events today; the cached `remaining` is the fallback and TB-022's live count overlays it.
- **An invalidation that cannot happen:** throws (not ready, or past the deadline) — never swallowed, never a hang.

---

## 7. What I'd do differently

Read the driver's reconnect path before writing "the in-flight command rejects". The ADR made a claim about ioredis I had not checked, the second time in two tasks; the reviewer's proxy script took ten minutes and disproved it.

---

## 8. Follow-ups left behind

- [ ] **TB-019:** single-flight on a cold key; negative caching of `null` for 30 s; hit/miss counters and `/_stats`; the "cached" row in BENCHMARKS §2 against the **indexed** baseline (23.1 ms / 311 req/s / mean 159.6 ms).
- [ ] **TB-019a (spike):** comment out the `DEL`… there is no caller yet; the spike edits the row in `psql` and watches 300 s of staleness, then refreshes a key with a plain `SET` and reads `TTL -1`.
- [x] **TB-022:** the cached `remaining` is the fallback; add the integration test that the live count overrides it (ADR 0002) — `composition.test.ts` "shows the live counter, not the cached count".
- [ ] **When an event writer exists:** the decorator's own `save` wraps the inner `save` and `DEL`s after the commit; normalise the id's case at the `presentation/` boundary first.
- [ ] **`pingWithin` and `within`:** the same ten lines in two layers; a shared `infrastructure/system` helper would be the place if a third copy appears.
- [ ] **If the "second read from Redis" tests ever flake on CI:** move the assertion to a spy on the inner repository; do not raise the deadline.
