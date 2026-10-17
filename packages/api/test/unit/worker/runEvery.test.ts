import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvery } from "../../../src/worker/runEvery.js";

// Fake timers, no sleeping: the interval is advanced by hand.
const INTERVAL_MS = 5_000;

describe("runEvery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks once per interval, never at zero", async () => {
    let ticks = 0;
    const stop = runEvery(
      INTERVAL_MS,
      async () => {
        ticks += 1;
      },
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    const beforeFirst = ticks;
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    stop();

    expect(beforeFirst).toBe(0);
    expect(ticks).toBe(3);
  });

  it("skips a tick while the previous one is still running, instead of stacking them", async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const stop = runEvery(
      INTERVAL_MS,
      () => {
        started += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    const whileRunning = started;
    release();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    stop();

    expect(whileRunning).toBe(1);
    expect(started).toBe(2);
  });

  it("hands a failing tick to onError and keeps ticking", async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const stop = runEvery(
      INTERVAL_MS,
      async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("redis is away");
      },
      (err) => errors.push(err),
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(ticks).toBe(2);
  });

  it("ticks no more once stopped", async () => {
    let ticks = 0;
    const stop = runEvery(
      INTERVAL_MS,
      async () => {
        ticks += 1;
      },
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(ticks).toBe(1);
  });
});
