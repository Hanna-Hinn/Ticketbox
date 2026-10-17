import { InvalidQuantity } from "../errors/InvalidQuantity.js";

// How many tickets one hold (or one order line) is for. The upper bound is a
// business rule, not a technical one: nobody gets to reserve the whole room.
export class Quantity {
  static readonly MAX_PER_HOLD = 10;

  private constructor(readonly value: number) {}

  static of(value: number): Quantity {
    if (!Number.isInteger(value) || value < 1 || value > Quantity.MAX_PER_HOLD) {
      throw new InvalidQuantity(value, Quantity.MAX_PER_HOLD);
    }
    return new Quantity(value);
  }
}
