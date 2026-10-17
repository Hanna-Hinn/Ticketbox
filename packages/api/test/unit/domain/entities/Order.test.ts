import { describe, expect, it } from "vitest";
import { Order, type OrderItem } from "../../../../src/domain/entities/Order.js";
import { InvalidOrder } from "../../../../src/domain/errors/InvalidOrder.js";
import { holdToken } from "../../../../src/domain/value-objects/HoldToken.js";
import { orderId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { Money } from "../../../../src/domain/value-objects/Money.js";
import { Quantity } from "../../../../src/domain/value-objects/Quantity.js";

const createdAt = new Date("2026-01-01T10:02:00.000Z");

function item(tier: string, qty: number, unitPriceCents: number): OrderItem {
  return {
    tierId: tierId(tier),
    qty: Quantity.of(qty),
    unitPrice: Money.fromCents(unitPriceCents),
  };
}

function anOrder(items: OrderItem[], at: Date = createdAt): Order {
  return Order.create({
    id: orderId("o-1"),
    holdToken: holdToken("tok-1"),
    email: "hanna@example.com",
    items,
    createdAt: at,
  });
}

describe("Order", () => {
  it("totals a single line", () => {
    const order = anOrder([item("general", 2, 2000)]);

    expect(order.total().cents).toBe(4000);
  });

  it("totals mixed tiers: 2 × €20 General + 1 × €35 Balcony = €75", () => {
    const order = anOrder([item("general", 2, 2000), item("balcony", 1, 3500)]);

    expect(order.total().cents).toBe(7500);
  });

  it("rejects an order with no items", () => {
    expect(() => anOrder([])).toThrow(InvalidOrder);
  });

  it("is unaffected by the caller mutating the array it was built from", () => {
    const items = [item("general", 2, 2000)];
    const order = anOrder(items);

    items.push(item("balcony", 1, 3500));

    expect(order.items).toHaveLength(1);
    expect(order.total().cents).toBe(4000);
  });

  it("exposes its items as a frozen array", () => {
    const order = anOrder([item("general", 2, 2000)]);

    expect(Object.isFrozen(order.items)).toBe(true);
  });

  it("does not alias the caller's creation instant", () => {
    const at = new Date(createdAt.getTime());
    const order = anOrder([item("general", 1, 2000)], at);

    at.setTime(0);
    order.createdAt.setTime(0);

    expect(order.createdAt).toEqual(createdAt);
  });
});
