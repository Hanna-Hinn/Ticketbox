# TB-018 — CachedEventRepository decorator

**Status:** Approved
**Date:** 2026-10-17
**Task:** TB-018 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-018-cached-event-repository` (stacked on `feat/TB-017-redis-client-and-keys`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Why:** the cleanest demonstration in the project that a good boundary lets you add infrastructure invisibly.

**Scope:** `CachedEventRepository implements EventRepository`, wrapping another `EventRepository`. JSON serialisation; **deserialise back through a Zod schema** because cached data is untrusted input. 300s TTL. Explicit `DEL` on writes. Wire it in the composition root **only**.

**Acceptance:** **zero changes to any controller or use case in this PR.** If the diff touches `presentation/` or `application/`, the pattern was implemented wrong — reject your own PR.

**Tests:** **unit** with a fake inner repo — miss then hit; the inner repo is called exactly once for two reads; a Zod parse failure is treated as a miss, never a 500. **Integration** with real Redis — the key exists with the right TTL; invalidation removes it.

**Depends on:** TB-017 (open, PR #20, the base of this branch), TB-010 (open, PR #13, below in the stack) — confirmed: ☑

---

## 2. What I understand this to mean

A decorator: the same port in, the same port out, Redis in between, and nobody above L3 can tell. `GET /events/:id` today runs `findById` → two Postgres queries (23 ms after TB-013's index). After this task the first read still does, and the next 300 seconds of reads for that event come from one Redis `GET`. The use case, the controller and the DTOs do not change — that is the acceptance line, and `git diff --stat` on the PR is its proof.

The cached bytes are untrusted: anything could have written that key (a different version of this code, a hand edit in RedisInsight, a bit of the TB-019a spike). So the decorator parses what it reads through a Zod schema and, on failure, behaves exactly as on a miss: reads through, re-caches, logs. A corrupt cache entry is never a 500.

---

## 3. Approach

### Layers touched

| Layer                      | What changes                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| L1, L2, `presentation/`    | **None** — the acceptance line                                                                |
| L3 `infrastructure/redis/` | New: `CachedEventRepository.ts`; `keys.ts` gains `eventCache(eventId)`                        |
| L4 `main/composition.ts`   | `events = new CachedEventRepository(new PgEventRepository(pool), redis, log)`                 |
| tests                      | unit with `InMemoryEventRepository` + an in-memory cache fake; integration against Redis DB 9 |
| docs                       | ADR 0003: cache-aside over write-through, and fail-open                                       |

### The decorator

```
findById(id)
  cache not ready            → inner.findById(id)                          (decision 6: never wait on a dead Redis)
  GET cache:event:<id>
    hit, parses               → Event.create(…)  — no Postgres
    hit, Zod rejects          → log.warn, treat as miss
    miss                      → inner.findById(id)
                                 null → return null (not cached; TB-019 adds negative caching)
                                 event → SET cache:event:<id> <json> EX 300 → return event
  any cache command throws   → log.warn, continue as if miss              (decision 6)

listUpcoming(now)            → inner.listUpcoming(now)                     (decision 2: pass-through)

invalidate(id)               → DEL cache:event:<id>                        (decision 4: the "explicit DEL on writes"; no writer exists yet)
```

Serialised shape (the Zod schema is the contract; `startsAt` as ISO, `price` as cents):

```ts
{ id, name, venue, startsAt, tiers: [{ id, eventId, name, priceCents, total, remaining }] }
```

The schema is strict enough that a payload it accepts cannot fail the domain constructors: non-negative integers, `remaining ≤ total` (refine), every `tier.eventId === id` (refine), ISO datetime. After `parse`, `Money.fromCents`, `TicketTier.create` and `Event.create` rebuild the entities; they are the same invariants, checked twice, and the second check is the one that would throw — so the first makes sure it never does.

### Decisions this plan is making

1. **Cache-aside, not write-through** (ADR 0003). There is no write path for events in this system — the seed inserts once, nothing updates — so write-through has nothing to hang off; and the handbook names cache-aside as the pattern to learn. The costs it carries (a stale window of up to 300 s; stampede on a cold key) are exactly what TB-019 and TB-019a exist to show.
2. **Only `findById` is cached.** `listUpcoming(now)` is a query over time: its answer changes with the clock, and caching it under one key would serve events that have already started until the TTL runs out. It also is not the endpoint the benchmark rows compare (`/events/:id`, BENCHMARKS §1–2). Pass-through, said in the file.
3. **Key: `ticketbox:v1:cache:event:<eventId>`**, added to `keys.ts` as `eventCache(id: EventId)`. A distinct `cache:` namespace so TB-040's `SCAN` experiments and a future "flush the cache" can target cache keys without touching holds.
4. **`invalidate(eventId)` is a public method on the class, not on the port.** The Scope says "explicit `DEL` on writes"; there are no writes yet. The method exists, is integration-tested ("invalidation removes it"), and the composition root does not wire it to anything. Adding it to `EventRepository` would widen L2's port for a concern L2 does not have (L2 never writes events), and the acceptance line forbids touching `application/` anyway. TB-019a's spike comments this method's call out — which today means nothing, since nothing calls it; the spike edits the key directly in `psql` as its Scope says.
5. **The decorator takes a narrow structural type, not `Redis`.** `CacheClient = Pick<Redis, "get" | "set" | "del" | "status">`-shaped, declared in the file. The ioredis client satisfies it; the unit tests pass a 20-line `Map`-backed fake with a settable `status`. No port, no abstraction beyond what the Tests line ("unit with a fake inner repo") forces: the inner repo is faked with `InMemoryEventRepository`, and the cache has to be faked too or the unit test needs Docker.
6. **Fail-open, and never wait on a dead Redis.** TB-017 left the offline queue on, so a `GET` issued while Redis is reconnecting does not fail — it waits, up to 20 reconnect attempts. A cache that turns a Redis outage into a hung `GET /events/:id` is worse than no cache. So: if `cache.status !== "ready"`, skip Redis and read through; if a cache command throws, log at warn and continue as a miss. Reads then behave exactly as before this task while Redis is gone, which is what TB-039 ("reads succeed via Postgres") will assert end-to-end. This is the one design choice in the task that is not in the Scope line; it is in the ADR, and the plan's §6 is why.
7. **`SET … EX 300`, always.** Never a refresh with a plain `SET`: that clears the TTL and makes the key immortal (handbook §7.1; TB-019a demonstrates it on purpose). The TTL is a constant in the file, `CACHE_TTL_SECONDS = 300`, not a config value — nothing asked for one.
8. **A `null` from the inner repository is not cached.** Negative caching is TB-019's Scope, with its own TTL (30 s) and its own test.
9. **Logging:** miss and hit are not logged (TB-019 adds counters and `/_stats`); a Zod rejection is a `warn` with the key and the issue path, never the payload (it is untrusted and could be anything); a cache command failure is a `warn` with the error (through the same shape TB-017 uses).
10. **Nothing in `presentation/` or `application/` changes**, and the PR body quotes `git diff --stat` to show it.

### New or changed ports / Redis keys / Lua scripts

No ports. Key: `ticketbox:v1:cache:event:<eventId>` (string, JSON, TTL 300 s, written by the decorator on a miss, read by the decorator, deleted by `invalidate`). No Lua.

---

## 4. Files

| File                                                                        | New / Changed                 |
| --------------------------------------------------------------------------- | ----------------------------- |
| `packages/api/src/infrastructure/redis/CachedEventRepository.ts`            | New                           |
| `packages/api/src/infrastructure/redis/keys.ts`                             | Changed — `eventCache`        |
| `packages/api/src/main/composition.ts`                                      | Changed — wrap the repository |
| `packages/api/test/fakes/InMemoryCache.ts`                                  | New — the `CacheClient` fake  |
| `packages/api/test/unit/infrastructure/redis/CachedEventRepository.test.ts` | New                           |
| `packages/api/test/unit/infrastructure/redis/keys.test.ts`                  | Changed — the cache key       |
| `packages/api/test/integration/redis/CachedEventRepository.test.ts`         | New                           |
| `docs/adr/0003-cache-aside-over-write-through.md`                           | New                           |

---

## 5. Test plan

| Level       | Test                                                                                                                      | What it would catch                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Unit        | first read is a miss and calls the inner repo; second read is a hit; the inner repo was called exactly once               | the cache not caching              |
| Unit        | the hit returns an `Event` equal to the inner one (id, name, venue, `startsAt`, every tier field incl. price)             | a lossy round trip                 |
| Unit        | a cached value that is not JSON / not the shape / violates a refinement → inner called, value re-cached, no throw         | a corrupt entry becoming a 500     |
| Unit        | an unknown id → `null`, nothing cached, inner called on every read                                                        | accidental negative caching        |
| Unit        | cache `status !== "ready"` → inner called, no cache command issued                                                        | a hung read while Redis is down    |
| Unit        | a cache `get`/`set` that throws → inner called, result returned                                                           | a cache failure becoming a 500     |
| Unit        | `listUpcoming` passes through untouched                                                                                   | the list being cached by mistake   |
| Unit        | `invalidate` then read → inner called again                                                                               | `DEL` not clearing                 |
| Integration | after one read the key exists, is JSON, and `PTTL` is within (295 s, 300 s]                                               | a plain `SET` without `EX`         |
| Integration | `invalidate` removes the key (`EXISTS` → 0)                                                                               | wrong key or no `DEL`              |
| Integration | a hand-corrupted key (`SET` to `"{"`) → read succeeds from Postgres and the key is rewritten                              | the fail-safe against a real Redis |
| Integration | `compose()` → `GET /events/:id` twice → one Postgres `tiers` query (counted through a `pg` query spy) and the key present | the wiring in the composition root |

**Concurrency:** N/A here; TB-019's stampede test is the concurrency test for this path.

**How the tests will be proven able to fail:** remove the `SET`; drop `EX`; return the parsed JSON without the Zod step; remove the `status` guard; remove the `try/catch`.

---

## 6. Risks and failure modes

- **What if Redis is down?** Reads bypass the cache (decision 6) and behave as before this task: Postgres answers in ~23 ms. No request waits on the offline queue. `/health` already says `redis: "down"`.
- **What if Redis dies mid-request?** The in-flight `GET` rejects (socket closed) → caught → read through. Tested at the unit level with a throwing fake; the real-Redis equivalent is TB-039's.
- **What if a key is evicted under `allkeys-lru`?** It is a cache: eviction is a miss, by design. This is the one key family in the system for which eviction is harmless — TB-040 contrasts it with the hold keys.
- **What if this operation runs twice?** Two misses for the same key race to `SET`; both write the same bytes; last writer wins; harmless. (The _stampede_ — 50 misses each hitting Postgres — is TB-019.)
- **What if it dies halfway through?** Between `inner.findById` and `SET`: nothing cached, next read misses again. Between `SET` and the return: the value is cached and correct.
- **Stale data:** up to 300 s after any change to an event. Events do not change today; TB-019a makes one change in `psql` and watches. The `remaining` inside the cached tiers is the Postgres-computed fallback, and `GetEventAvailabilityUseCase` already overlays the live count (`live.get(id) ?? tier.remaining`, ADR 0002) — so once TB-022 exists, the cache carries the fallback only and the number on screen stays live.

---

## 7. Could Postgres already do this?

Yes — it already does, in 23 ms with the TB-013 index, and the honest comparison is TB-019's acceptance line: the "cached" row against the **indexed** baseline. What the cache buys is not correctness and may not be much latency on this data set; it buys fewer Postgres round-trips per read and a demonstration that the boundary holds. ADR 0003 says so, including the case for not caching at all, and BENCHMARKS §2 (TB-019) decides with numbers.

---

## 8. Open questions

None blocking. Decision 6 (fail-open with a `status` guard) is the one a reviewer may want argued the other way — e.g. a per-command timeout instead of the status check, or fail-closed.

---

## 9. Documentation this task will produce

- ☑ ADR — `docs/adr/0003-cache-aside-over-write-through.md`
- ☑ Task doc — `docs/tasks/TB-018-cached-event-repository.md`
- ☐ Benchmark entry — TB-019's
- ☐ NOTES entry — not a SPIKE task (TB-019a is)
