# TB-020 — Hold use cases against in-memory fakes

**Status:** In review (PR open, stacked — not merged by design)
**Date completed:** 2026-10-17
**Task:** TB-020 (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-020-hold-use-cases.md`](../implementation-plans/TB-020-hold-use-cases.md)
**Branch / PR:** `feat/TB-020-hold-use-cases` · [#24](https://github.com/Hanna-Hinn/Ticketbox/pull/24) (based on #23, the TB-019a write-up, which sits on #22)
**ADR:** none — use-case shape, not architecture

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

The whole life of a hold, as use cases over ports with nothing underneath but fakes: created (`CreateHold`, unchanged), read back with the time it has left (`GetHold`), released exactly once (`ReleaseHold`), and gone after its TTL — gone to the client, but with its tickets still counted as held, because expiry is not a release. The `HoldStore` port gained its one missing read, `find(token)`. The in-memory store now takes a `Clock` and behaves, on expiry, the way Redis will.

---

## How it works

```
CreateHold   reserve(tier, qty, token, ttl)   → { ok, remaining } | insufficient
GetHold      find(token) → Hold | null ; now = clock.now()  (after the lookup)
               null, or hold.isExpired(now)   → { ok: false, reason: "not-found" }
               else                           → { ok: true, …, expiresAt, remainingMs: hold.remainingMs(now) }
ReleaseHold  release(token)                   → { released: true, tierId, remaining } | { released: false }
```

Two invariants carry the task, and both now exist as tests rather than comments. **`GetHold` reads the clock after the lookup**, so the remaining time it reports is computed from an instant no earlier than the store's answer — the client is never told more time than is really left (the mirror of `CreateHold` reading the clock _before_ the reserve, so the expiry it reports is never later than the store's). **`ReleaseHold` makes one call**: a `find` followed by a `release` is two commands with a gap, and the gap is where a second release or the TTL slips in; the store's compare-and-restore decides once, and its `{ released: false }` covers the repeat, the unknown token and the expired hold alike — which is what makes release safe to repeat.

The fake's expiry semantics are the lesson pinned early: past its TTL a hold is not there (`find` → `null`, `release` → `{ released: false }`) **and its quantity is not restored**. Redis will drop the key and leave the tier counter alone; the sweeper (TB-026) reconciles. A fake that quietly restored on expiry would have hidden the reason the sweeper exists.

### Layers touched

| Layer                                     | What changed                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| L1 `domain/**`                            | nothing — `Hold.isExpired` / `remainingMs` already own the definition                                                    |
| L2 `application/**`                       | `ports/HoldStore.ts` + `find`; `use-cases/GetHold.ts`, `use-cases/ReleaseHold.ts` (new)                                  |
| L3 `infrastructure/**`, `presentation/**` | `infrastructure/system/UnconfiguredHoldStore.ts` gains `find` (throws, like its siblings); no route yet (TB-023, TB-025) |
| L4 `main/**`, `worker/**`                 | nothing                                                                                                                  |
| test fakes                                | `InMemoryHoldStore(clock)` stores `Hold` entities, expires them, never restores on expiry; `stubHoldStore(overrides)`    |

### Key files

| File                                                                 | What it does                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/api/src/application/use-cases/GetHold.ts`                  | find → clock → entity decides → plain data for the checkout page                                |
| `packages/api/src/application/use-cases/ReleaseHold.ts`              | one compare-and-restore call, passed through                                                    |
| `packages/api/test/fakes/InMemoryHoldStore.ts`                       | the port's contract with expiry on the injected clock and no restore on expiry                  |
| `packages/api/test/fakes/stubHoldStore.ts`                           | a store that rejects every call a test did not override — proves a use case makes only one call |
| `packages/api/test/unit/application/use-cases/HoldLifecycle.test.ts` | the Acceptance line as one test through the three use cases                                     |

### Redis keys introduced

| Key  | Type | TTL | Who writes it | Who reads it |
| ---- | ---- | --- | ------------- | ------------ |
| none |      |     |               |              |

### Lua scripts introduced

| Script | The race it prevents |
| ------ | -------------------- |
| none   |                      |

---

## 3. Where this diverged from the plan

| Planned                                                                                 | What actually happened                                                                                                                                                        | Why                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/composition.ts` changes for the placeholder store                                 | The placeholder lives in `infrastructure/system/UnconfiguredHoldStore.ts`; that file changed, `composition.ts` did not                                                        | I named the wrong file from memory; the plan's table was corrected before coding.                                                                                            |
| Call sites: `{health,events,errors}.test.ts`                                            | `stats.test.ts` too                                                                                                                                                           | Written in TB-019, missed in the list; it would not compile otherwise. Review Minor.                                                                                         |
| Test plan: the invariants "clock after lookup" and "no find before release" as comments | Both are tests now: a stub store whose `find` advances the clock by 1 s (`remainingMs: TTL − 1000`), and a stub whose `find` rejects while `release` answers                  | Review Majors: the reviewer's sabotages S4 and S5 (swap the clock read; insert a find) left 147 tests green. A comment is not an invariant.                                  |
| The lifecycle "specified in unit tests" across three files                              | One `HoldLifecycle.test.ts` runs create → get → advance → get → release → get → release-again → availability through the use cases, plus the expire-but-not-restored path     | Review "For the Test Phase": the Acceptance line says _the full lifecycle_; piecewise files each seeded the store by calling `reserve` directly, never through `CreateHold`. |
| Hand-rolled stub in one test                                                            | `test/fakes/stubHoldStore.ts`, used by three tests                                                                                                                            | The review said a helper is justified when the second copy appears; Phase 4 produced the second and third.                                                                   |
| The fake mirrors Redis                                                                  | It is stricter than Redis in two places, now stated in its header: a reused token throws even after the earlier hold expired, and `Quantity.of` throws on an out-of-range qty | Review Minors: both are test-authoring bugs the fake should make loud; TB-022's integration tests must not inherit either as a Redis behaviour.                              |

Nothing diverged in the use cases themselves; the plan's seven decisions all stood.

---

## 4. Tests shipped

| Level       | Test file                                                       | Behaviour asserted                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `test/unit/application/use-cases/CreateHold.test.ts` (existing) | create reduces availability; a hold beyond `Quantity.MAX_PER_HOLD` is rejected before touching the store                                                                                                                                                                |
| Unit        | `test/unit/application/use-cases/ReleaseHold.test.ts`           | restores the exact quantity; **releasing twice restores only once**; unknown token is `{ released: false }`; **an expired hold cannot be released and its inventory stays reduced**; one ms before expiry it can; releases with a single store call and no lookup first |
| Unit        | `test/unit/application/use-cases/GetHold.test.ts`               | token, tier, qty, `expiresAt`, `remainingMs`; counts down from the injected clock; unknown → `not-found`; alive at TTL−1 ms with `remainingMs: 1`, gone at TTL; an expired hold the store hands back is still `not-found`; reads the clock after the lookup             |
| Unit        | `test/unit/application/use-cases/HoldLifecycle.test.ts`         | the whole lifecycle through the three use cases, ending with availability back at 10 and a second release refused; left alone, a hold expires (gone to the client) with its tickets still held                                                                          |
| Unit        | `test/unit/fakes/fakes.test.ts`                                 | `find` returns the live hold; an expired hold is forgotten without giving its inventory back                                                                                                                                                                            |
| Integration | —                                                               | none; the Scope line is "against in-memory fakes"                                                                                                                                                                                                                       |
| Concurrency | —                                                               | none; a single-threaded fake cannot interleave — TB-021 produces the race, TB-022 fixes it against Redis                                                                                                                                                                |
| Smoke / E2E | —                                                               | unchanged                                                                                                                                                                                                                                                               |

Final run on `48e26a3`: typecheck clean, `lint --max-warnings 0` clean, unit **151 passed** (20 files); the http integration tests (28) green on the earlier head with the same fake changes.

**Proven able to fail** — seven sabotages, three run by the reviewer on `749acae`, four here on `48e26a3`, each restored from git:

```
S1 (reviewer)  fake release ignores expiry (holds.get instead of live)
               × forgets an expired hold without giving its inventory back
               × cannot release an expired hold, and does not give its inventory back either   2 failed
S2 (reviewer)  GetHold drops hold.isExpired(now)
               × does not trust the store on time: an expired hold it hands back is not found   1 failed
S3 (reviewer)  fake restores the tier counter when it forgets an expired hold
               the same two as S1                                                               2 failed
S4  GetHold reads the clock before the lookup
               × reads the clock after the lookup, so it never overstates the time left         1 failed  (was green before Phase 4)
S5  ReleaseHold does find, then release
               × releases with a single store call and no lookup first                         1 failed  (was green before Phase 4)
S6  fake release forgets to restore
               × restores exactly the held quantity … × releasing twice restores only once
               × can still release one ms before … × restores inventory on release exactly once
               × is created, counts down, is released once, and is then gone                    5 failed
S7  remainingMs computed from the hold's creation instant instead of the clock
               × is created, counts down … × counts the remaining time down from the injected clock
               × is still there one ms before … × reads the clock after the lookup              4 failed
```

**Coverage after this task:** not measured — the gates are TB-042's. Both new use cases have every branch under a unit test.

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`, dispatched via the Agent tool. It ran typecheck, lint, unit and the http integration tests, grepped the layer and rigour rules, and ran five sabotages, two of which stayed green.
**Verdict:** **SAFE TO MERGE** on `749acae`, with two Majors that were tests to write, not code to change.

| Finding                                                                                                 | Severity | Resolution                                                     |
| ------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `ReleaseHold`'s only invariant (one call, no read first) existed as a comment; sabotage S5 stayed green | Major    | Test with a stub store whose reads reject                      |
| `GetHold`'s clock-after-lookup order untested; sabotage S4 stayed green                                 | Major    | Test with a stub store whose `find` advances the clock         |
| Duplicate-token guard and `Quantity.of` make the fake stricter than Redis                               | Minor    | Stated in the fake's header comment                            |
| `stats.test.ts` missing from the plan's file list                                                       | Minor    | Recorded in §3                                                 |
| `TicketTierRepository` port has no consumer (pre-existing; decision 1 keeps it that way)                | Minor    | Recorded below; not deleted here                               |
| Hand-rolled stub would be copied; a helper is justified at the second copy                              | Minor    | `stubHoldStore` added in Phase 4 when the second copy appeared |

Findings deliberately **not** fixed: none. The reviewer's fifth Test Phase item ("`ok: true` never carries `remainingMs: 0`") is covered by the boundary test (alive at TTL−1 with `remainingMs: 1`, gone at TTL) together with the stub test that hands back an expired hold; no separate assertion was added.

---

## 6. Failure modes, as built

- **Redis down:** not applicable — nothing here talks to Redis. The use cases propagate whatever the store throws; what a dead store does is TB-022's decision.
- **Key evicted under `allkeys-lru`:** from these use cases' side an evicted hold is an expired hold — `not-found`, `{ released: false }` — which is why `find` answers `null` and not a reason.
- **Operation runs twice:** `ReleaseHold` twice restores once, by the store's compare-and-restore; tested. `GetHold` is a read.
- **Dies halfway through:** each new use case makes one port call; there is no halfway.
- **A slow store:** the time it spends answering `find` comes off the countdown the client is told, never added to it; tested.

---

## 7. What I'd do differently

Write the invariant tests with the invariant, not after a reviewer's sabotage shows the comment was all there was. Two of the seven sabotages were green on the first commit; the plan's "how each test will be proven able to fail" list did not include them because I had not thought of the comments as claims.

---

## 8. Follow-ups left behind

- [x] TB-025: what `GET /holds/:token` must carry for the checkout summary (tier name, price, event) — enrich in `GetHold` via `TicketTierRepository`, or let the UI keep the event it came from. Decided there, not here. _TB-025: the hold carries `eventId`; the checkout page fetches the event (a cache hit) and finds its tier. `GetHold` stays one lookup._
- [ ] `application/ports/TicketTierRepository.ts` has no consumer in `src/` or `test/`; decision 1 keeps it that way. Delete or use it when TB-025 decides the above. _TB-025 decided against using it; still unused, still not deleted._
- [ ] TB-024: `ReleaseHold` is where `HoldRepository.setStatus(token, "released")` lands; TB-027/SSE: where `EventPublisher.availabilityChanged` lands. Both refused here as speculative.
- [x] TB-022: the fake is stricter than Redis on a reused token and on an out-of-range qty — not inherited; `reserve(hold)` removed the qty check from the fake altogether, and the real store's reused-token behaviour is the replay guard (pays once).
