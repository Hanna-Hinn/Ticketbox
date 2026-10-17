import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReleaseExpiredHoldsUseCase } from "../../../src/application/use-cases/ReleaseExpiredHolds.js";
import { holdToken } from "../../../src/domain/value-objects/HoldToken.js";
import { tierId } from "../../../src/domain/value-objects/Ids.js";
import { runMigrations } from "../../../src/infrastructure/postgres/migrations.js";
import { PgHoldRepository } from "../../../src/infrastructure/postgres/PgHoldRepository.js";
import { createPool } from "../../../src/infrastructure/postgres/pool.js";
import { seed } from "../../../src/infrastructure/postgres/seed.js";
import { aHold } from "../../fakes/builders.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";
import { connectToTestDatabase, resetSchema, testDatabaseUrl } from "../support/database.js";

const migrationsDir = fileURLToPath(new URL("../../../../../migrations/", import.meta.url));
const GENERAL = tierId("11111111-1111-4111-8111-aaaaaaaaaaaa");
// Short, so a stall is proven in milliseconds; production's is 5 s.
const BOUND_MS = 200;

// pg's defaults wait forever. A query behind a lock and a connection that
// never arrives must each fail within the bound, or the sweeper's overlap
// guard skips every later tick in silence (plan §6).
let locker: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  locker = await connectToTestDatabase();
  await resetSchema(locker);
  await runMigrations(locker, migrationsDir);
  await seed(locker);
});

afterAll(async () => {
  await locker.end();
});

beforeEach(() => {
  pool = createPool(testDatabaseUrl(), { connectionTimeoutMs: BOUND_MS, queryTimeoutMs: BOUND_MS });
});

afterEach(async () => {
  await locker.query("ROLLBACK").catch(() => undefined);
  await pool.end();
});

describe("createPool", () => {
  it("rejects a query blocked behind a lock within the bound, instead of waiting forever", async () => {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE holds IN ACCESS EXCLUSIVE MODE");
    const repo = new PgHoldRepository(pool);
    const started = Date.now();

    await expect(repo.setStatus(holdToken("tok-blocked"), "expired")).rejects.toThrow(
      /Query read timeout/,
    );

    expect(Date.now() - started).toBeLessThan(BOUND_MS * 5);
  });

  it("rejects a connection it cannot get within the bound", async () => {
    const one = createPool(testDatabaseUrl(), {
      connectionTimeoutMs: BOUND_MS,
      queryTimeoutMs: BOUND_MS,
    });
    // pg.Pool's default max is 10; take them all and ask for an eleventh.
    const taken = await Promise.all(Array.from({ length: 10 }, () => one.connect()));
    const started = Date.now();

    await expect(one.query("SELECT 1")).rejects.toThrow(/timeout exceeded when trying to connect/);

    expect(Date.now() - started).toBeLessThan(BOUND_MS * 5);
    taken.forEach((client) => client.release());
    await one.end();
  });

  it("lets the sweeper finish a pass with every hold restored and every stalled row reported", async () => {
    // The use case over the fake store and the real, bounded repository:
    // Postgres stalling costs the pass one bound per row, not the tickets.
    const clock = new FakeClock("2026-01-01T10:00:00.000Z");
    const holds = new InMemoryHoldStore(clock);
    holds.seed(GENERAL, 1000); // two holds of 1 take it to 998
    for (const token of ["tok-a", "tok-b"]) {
      await holds.reserve(
        aHold().forTier(GENERAL).withToken(token).withQty(1).createdAt(clock.now()).build(),
      );
    }
    clock.advance(120_000);
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE holds IN ACCESS EXCLUSIVE MODE");
    const useCase = new ReleaseExpiredHoldsUseCase(holds, new PgHoldRepository(pool), clock);
    const started = Date.now();

    const result = await useCase.execute();

    expect(Date.now() - started).toBeLessThan(BOUND_MS * 10);
    expect(result.swept).toBe(2);
    expect(result.restored).toBe(2);
    expect(result.unmarked.map((entry) => entry.token).sort()).toEqual(["tok-a", "tok-b"]);
    expect(
      result.unmarked.every(
        (entry) => entry.error instanceof Error && /Query read timeout/.test(entry.error.message),
      ),
    ).toBe(true);
    expect(await holds.availability([GENERAL])).toEqual(new Map([[GENERAL, 1000]]));
  });
});
