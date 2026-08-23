import { describe, expect, it } from "vitest";

describe("the unit test runner", () => {
  it("runs a trivial assertion to completion", () => {
    expect(1 + 1).toBe(2);
  });
});
