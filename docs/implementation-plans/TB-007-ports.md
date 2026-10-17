# TB-007 — Ports

**Status:** Implemented — see [`docs/tasks/TB-007-ports.md`](../tasks/TB-007-ports.md); the Phase 3 review changed four signatures before any implementation existed (decisions 2, 5, 8 and the §3 notes)
**Date:** 2026-10-17
**Task:** TB-007 (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-007-ports` (stacked on `feat/TB-006-entities-and-value-objects`)
**Approved by:** Hanna — blanket go-ahead given in the Claude Code session on 2026-10-17 ("do this project, one PR at a time, stacked PRs"); this plan was not individually reviewed before coding started. Pushback-worthy choices are listed under §3 "Decisions this plan is making".
**Approved on:** 2026-10-17

> **Nothing in this plan gets implemented until Status reads Approved.**

---

## 1. The task, verbatim from the delivery plan

**Scope:** `EventRepository`, `TicketTierRepository`, `HoldStore`, `HoldRepository`, `OrderRepository`, `Clock`, `TokenGenerator`, `EventPublisher`. Interfaces only, no implementations.

**Acceptance:** no port name contains a technology word. If you typed `Redis` or `Sql`, rename it.

**Tests:** none (types only).

**Depends on:** TB-006 (open, PR #9 — this branch is stacked on it) — confirmed: ☑ base of this branch

---

## 2. What I understand this to mean

Layer 2's contract with the outside world: eight TypeScript interfaces under `packages/api/src/application/ports/`, each named for what the domain needs and carrying only domain types and plain result objects. No class implements any of them in this PR. The in-memory fakes are TB-008; the real adapters are TB-010 (Postgres) and TB-022 (Redis).

The design content is the method signatures, because every later task is shaped by them and a port is expensive to change once two adapters and a fake implement it. The handbook already fixes `HoldStore` (§2.3, verbatim) and names the three `EventRepository` methods (TB-010). The rest is kept to the smallest surface a named later task needs, and that is the part a reviewer should push on.

---

## 3. Approach

### Layers touched

| Layer                   | What changes               |
| ----------------------- | -------------------------- |
| L1 `domain/**`          | None                       |
| L2 `application/ports/` | New: eight interface files |
| L3–L4                   | None                       |

### The ports

```ts
// Clock.ts            — never Date.now() in a use case (CLAUDE.md rule 5)
interface Clock {
  now(): Date;
}

// TokenGenerator.ts   — never crypto.randomUUID() in a use case
interface TokenGenerator {
  next(): HoldToken;
}

// EventRepository.ts  — Kind A, Postgres (TB-010)
interface EventRepository {
  findById(id: EventId): Promise<Event | null>; // tiers loaded; see decision 1
  listUpcoming(now: Date): Promise<readonly Event[]>; // starts_at > now, tiers loaded
}

// TicketTierRepository.ts — Kind A (TB-010); CreateHold needs "does this tier exist"
interface TicketTierRepository {
  findById(id: TierId): Promise<TicketTier | null>;
}

// HoldStore.ts        — Kind B, Redis (TB-022); the handbook §2.3 signature, verbatim
interface HoldStore {
  reserve(
    tierId,
    qty: number,
    token,
    ttlMs,
  ): Promise<{ ok: true; remaining: number } | { ok: false; reason: "insufficient" }>;
  release(
    token,
  ): Promise<{ released: true; tierId: TierId; remaining: number } | { released: false }>;
  availability(tierIds: readonly TierId[]): Promise<ReadonlyMap<TierId, number>>;
}

// HoldRepository.ts   — the Postgres mirror (TB-024): audit trail, never the live truth
type HoldStatus = "active" | "converted" | "expired" | "released"; // matches 003_holds.sql
interface HoldRepository {
  save(hold: Hold): Promise<void>; // writes status "active"
  setStatus(token: HoldToken, status: HoldStatus): Promise<void>;
}

// OrderRepository.ts  — Kind A (TB-029)
interface OrderRepository {
  save(order: Order): Promise<void>;
}

// EventPublisher.ts   — "hold created" without knowing whether that is Pub/Sub, a Stream, or nothing
interface EventPublisher {
  availabilityChanged(change: {
    eventId: EventId;
    tierId: TierId;
    remaining: number;
  }): Promise<void>;
}
```

### Decisions this plan is making

1. **`EventRepository` has `findById` and `listUpcoming`, not the three methods TB-010 names (`findById`, `findWithTiers`, `listUpcoming`).** `Event` (TB-006) _always_ carries `tiers`; a `findById` that returned an `Event` with `tiers: []` would be a lie the type cannot express ("no tiers" vs "not loaded"). So `findById` loads tiers and `findWithTiers` has nothing left to mean. This is a deliberate deviation from the TB-010 Scope wording, recorded here so TB-010's plan either accepts it or reinstates the method with a different entity shape. `listUpcoming` takes `now` as a parameter — the repository must not call `Date.now()` any more than a use case may.
2. **`HoldStore` is the handbook's signature, with two small tightenings:** `availability` returns `ReadonlyMap` (callers must not mutate what the store hands them), and `qty` stays a plain `number` as the handbook has it — ports carry simple data; the use case unwraps `Quantity.value` at the boundary. A `get(token)` method is _not_ added: `GetHoldUseCase` is TB-020, and that task adds what it needs.
3. **`HoldRepository` is `save` + `setStatus`.** TB-024's Tests line is exactly "creating a hold writes a row with status `active`; releasing updates it to `released`". `HoldStatus` lives in the port file: it is a storage-side lifecycle (the live hold in Redis has no status — it exists or it doesn't), so it is not a domain concept and does not go into `Hold`.
4. **`OrderRepository` is `save` only.** TB-029 confirms a hold into an order; nothing in the delivery plan reads an order back by id (the UI shows the order number from the confirm response; TB-030 replays the stored response from Redis). A `findById` nobody calls is speculation.
5. **`EventPublisher` has one method, `availabilityChanged`** _(changed after review; the handbook's trace §2.5 step 7 says `holdCreated`)_. A hold created (TB-008), released (TB-023) or swept (TB-026) all produce the identical `{ eventId, tierId, remaining }`, and TB-037's subscriber consumes only the effect. One method per cause would be three methods with one payload shape, and every fake and adapter growing with them. Note for TB-033/034: the `StreamPublisher` that carries order-confirmed work to a worker is a _different_ port (a job, not an availability hint), not a second method here.
6. **No barrel `index.ts`.** Imports name the file; a barrel is a place for circular imports to hide.
7. **`readonly` on every array/map a port returns.** The same lesson TB-006 paid for: a port that hands out a mutable collection hands out shared state.
8. **`HoldRepository.setStatus` takes `HoldOutcome = Exclude<HoldStatus, "active">`** _(review)_. A row is born `active` through `save` and ends in exactly one other state; a use case that could rewind `converted` to `active` could rewrite the audit trail. `HoldStatus` stays in the application layer: the use cases (release, sweep, confirm) are what choose a status.
9. **Cost of decision 1, for TB-010 to confront** _(review)_: `listUpcoming` must compute `total − sold − active holds` for every tier of every upcoming event, because `TicketTier.remaining` is required and the list page reads only `name`/`venue`/`startsAt`. That is also the query TB-013 benchmarks and TB-018 caches. A lighter list shape is a TB-010 plan question, not a TB-007 one.
10. **One transaction, two ports — for TB-029 to decide** _(review)_: confirming an order writes `orders` + `order_items` _and_ marks the hold `converted`, and TB-033 adds an outbox row "in the same transaction". `OrderRepository.save` and `HoldRepository.setStatus` cannot share a transaction as defined. No unit-of-work port is added now (speculative); TB-029 must either have `OrderRepository.save` mark the hold converted inside its own transaction, or introduce a transaction port — explicitly, in its plan.
11. **Open questions this port shape leaves for the tasks that implement it** _(review)_: TB-029 needs an `OrderId` source (`TokenGenerator.next()` gives only a `HoldToken`; `crypto.randomUUID()` in a use case is banned — extend the port or add an `IdGenerator` then). TB-022 must decide what `reserve` returns when the tier's counter key does not exist (after `FLUSHDB`, before a reconcile): "insufficient" or a distinct state matters to TB-027 and TB-039's 503. TB-022 must also name which clock the sweeper's ZSET score comes from — `Clock.now()` sets the `expiresAt` the UI counts down from, while the adapter only receives a relative `ttlMs`.

### New or changed Redis keys / Lua scripts / migrations

None.

---

## 4. Files

| File                                                         | New / Changed |
| ------------------------------------------------------------ | ------------- |
| `packages/api/src/application/ports/Clock.ts`                | New           |
| `packages/api/src/application/ports/TokenGenerator.ts`       | New           |
| `packages/api/src/application/ports/EventRepository.ts`      | New           |
| `packages/api/src/application/ports/TicketTierRepository.ts` | New           |
| `packages/api/src/application/ports/HoldStore.ts`            | New           |
| `packages/api/src/application/ports/HoldRepository.ts`       | New           |
| `packages/api/src/application/ports/OrderRepository.ts`      | New           |
| `packages/api/src/application/ports/EventPublisher.ts`       | New           |

---

## 5. Test plan

**Tests:** none — "types only", per the Tests line. `pnpm typecheck` is the check that the interfaces are well-formed and import only `domain/**`. The Acceptance line ("no technology word in a port name") is checked by reading the eight file names; TB-009's lint rule later makes the import constraint mechanical.

| Level       | Test | What it would catch |
| ----------- | ---- | ------------------- |
| Unit        | N/A  | —                   |
| Integration | N/A  | —                   |
| Concurrency | N/A  | —                   |

---

## 6. Risks and failure modes

- **What if Redis is down?** A port cannot be down. The _adapter_ behind `HoldStore` will throw on a dead connection (bugs are exceptions), and TB-039 decides per endpoint whether that is fail-open or fail-closed. The port's result type deliberately has no `"unavailable"` reason: that would push an infrastructure state into every use case.
- **What if a key is evicted under `allkeys-lru`?** N/A here; the `HoldStore` adapter's problem (TB-022, TB-040).
- **What if this operation runs twice?** Each port's idempotency is specified by the task that implements it (TB-023 for `release`, TB-026 for the sweeper). The `release` result `{ released: boolean }` is shaped so that "already released" is a value, not an error.
- **What if it dies halfway through?** N/A — interfaces.

---

## 7. Could Postgres already do this?

N/A — no Redis capability is added. The split _is_ visible in the port list, though: `HoldStore` (Kind B, rebuildable) versus `HoldRepository` (Kind A, the audit trail). Two ports for one concept is the whole lesson of TB-024, and it is encoded here first.

---

## 8. Open questions

None blocking. Decision 1 (dropping `findWithTiers`) is the one a reviewer may want reversed; it is reversible until TB-010 implements the port.

---

## 9. Documentation this task will produce

- ☐ ADR — not needed
- ☑ Task doc — `docs/tasks/TB-007-ports.md`
- ☐ Benchmark entry — nothing measured
- ☐ NOTES entry — not a SPIKE task
