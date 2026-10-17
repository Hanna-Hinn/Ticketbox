import { describe, expect, it } from "vitest";
import { InvalidQuantity } from "../../../../src/domain/errors/InvalidQuantity.js";
import { Quantity } from "../../../../src/domain/value-objects/Quantity.js";

describe("Quantity", () => {
  it("caps a single hold at 10 tickets", () => {
    expect(Quantity.MAX_PER_HOLD).toBe(10);
  });

  it.each([1, 5, 10])("accepts %i", (value) => {
    expect(Quantity.of(value).value).toBe(value);
  });

  it.each([0, -1, 11, 1.5, Number.NaN])("rejects %s", (value) => {
    expect(() => Quantity.of(value)).toThrow(InvalidQuantity);
  });
});
