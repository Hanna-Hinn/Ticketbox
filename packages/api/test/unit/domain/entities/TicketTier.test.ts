import { describe, expect, it } from "vitest";
import { TicketTier, type TicketTierProps } from "../../../../src/domain/entities/TicketTier.js";
import { InvalidTicketTier } from "../../../../src/domain/errors/InvalidTicketTier.js";
import { eventId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { Money } from "../../../../src/domain/value-objects/Money.js";
import { Quantity } from "../../../../src/domain/value-objects/Quantity.js";

function tierWith(overrides: Partial<TicketTierProps>): TicketTier {
  return TicketTier.create({
    id: tierId("t-1"),
    eventId: eventId("e-1"),
    name: "Balcony",
    price: Money.fromCents(3500),
    total: 100,
    remaining: 12,
    ...overrides,
  });
}

describe("TicketTier", () => {
  it("can fulfil a request that fits in what remains", () => {
    const tier = tierWith({ remaining: 12 });

    expect(tier.canFulfil(Quantity.of(2))).toBe(true);
    expect(tier.canFulfil(Quantity.of(10))).toBe(true);
  });

  it("can fulfil a request for exactly what remains", () => {
    const tier = tierWith({ remaining: 3 });

    expect(tier.canFulfil(Quantity.of(3))).toBe(true);
  });

  it("cannot fulfil a request larger than what remains", () => {
    const tier = tierWith({ remaining: 3 });

    expect(tier.canFulfil(Quantity.of(4))).toBe(false);
  });

  it("cannot fulfil even one ticket when sold out", () => {
    const tier = tierWith({ remaining: 0 });

    expect(tier.canFulfil(Quantity.of(1))).toBe(false);
  });

  it.each([
    ["negative remaining", { remaining: -1 }],
    ["remaining above total", { total: 10, remaining: 11 }],
    ["negative total", { total: -1, remaining: 0 }],
    ["fractional remaining", { remaining: 1.5 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => tierWith(overrides)).toThrow(InvalidTicketTier);
  });
});
