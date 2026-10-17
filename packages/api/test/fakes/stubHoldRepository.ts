import type { HoldRepository } from "../../src/application/ports/HoldRepository.js";

// A HoldRepository that answers only what a test overrides and rejects
// everything else — "a mirror that must not be called", or one that is
// down, as one named thing.
export function stubHoldRepository(overrides: Partial<HoldRepository> = {}): HoldRepository {
  const notInThisTest = (): Promise<never> =>
    Promise.reject(new Error("not expected in this test"));
  return { save: notInThisTest, setStatus: notInThisTest, ...overrides };
}
