import type { HoldStore } from "../../src/application/ports/HoldStore.js";

// A HoldStore that answers only what a test overrides and rejects everything
// else: the way to prove a use case makes exactly the call it should and
// no other.
export function stubHoldStore(overrides: Partial<HoldStore>): HoldStore {
  const notInThisTest = (): Promise<never> =>
    Promise.reject(new Error("not expected in this test"));
  return {
    reserve: notInThisTest,
    release: notInThisTest,
    availability: notInThisTest,
    find: notInThisTest,
    expired: notInThisTest,
    sweep: notInThisTest,
    held: notInThisTest,
    rebuild: notInThisTest,
    ...overrides,
  };
}
