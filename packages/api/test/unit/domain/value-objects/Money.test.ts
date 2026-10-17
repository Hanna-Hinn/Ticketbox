import { describe, expect, it } from "vitest";
import { InvalidMoney } from "../../../../src/domain/errors/InvalidMoney.js";
import { Money } from "../../../../src/domain/value-objects/Money.js";

describe("Money", () => {
  it("accepts zero and positive integer cents", () => {
    expect(Money.fromCents(0).cents).toBe(0);
    expect(Money.fromCents(1999).cents).toBe(1999);
    expect(Money.zero().cents).toBe(0);
  });

  it.each([19.99, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    "rejects %s as cents",
    (cents) => {
      expect(() => Money.fromCents(cents)).toThrow(InvalidMoney);
    },
  );

  it("multiplies a unit price by a count without losing a cent", () => {
    const total = Money.fromCents(1999).times(3);

    expect(total.cents).toBe(5997);
  });

  it("adds by value", () => {
    const sum = Money.fromCents(2000).add(Money.fromCents(3500));

    expect(sum.cents).toBe(5500);
  });

  it.each([1.5, -1, Number.NaN])("rejects %s as a multiplier, naming the multiplier", (count) => {
    expect(() => Money.fromCents(100).times(count)).toThrow(InvalidMoney);
    expect(() => Money.fromCents(100).times(count)).toThrow(/multiplier/);
  });

  it("refuses to add past the safe-integer ceiling instead of silently rounding", () => {
    const max = Money.fromCents(Number.MAX_SAFE_INTEGER);

    expect(() => max.add(Money.fromCents(1))).toThrow(InvalidMoney);
  });

  it("refuses to multiply past the safe-integer ceiling instead of silently rounding", () => {
    const max = Money.fromCents(Number.MAX_SAFE_INTEGER);

    expect(() => max.times(2)).toThrow(InvalidMoney);
  });

  it("compares by value, not by reference", () => {
    expect(Money.fromCents(500).equals(Money.fromCents(500))).toBe(true);
    expect(Money.fromCents(500).equals(Money.fromCents(501))).toBe(false);
  });

  it("does not mutate the operands", () => {
    const price = Money.fromCents(100);

    price.add(Money.fromCents(50));
    price.times(3);

    expect(price.cents).toBe(100);
  });
});
