import { InvalidMoney } from "../errors/InvalidMoney.js";

// Integer cents, one currency, never a float. 0.1 + 0.2 is not 0.3 in IEEE
// 754, and a box office that is off by a cent is a box office with a bug.
// isSafeInteger, not isInteger: above 2^53 an "integer" is already rounded,
// which is the only way integer arithmetic goes wrong in JavaScript.
export class Money {
  private constructor(readonly cents: number) {}

  static fromCents(cents: number): Money {
    if (!Number.isSafeInteger(cents) || cents < 0) {
      throw new InvalidMoney(`cents must be a non-negative safe integer, got ${cents}`);
    }
    return new Money(cents);
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return Money.fromCents(this.cents + other.cents);
  }

  times(count: number): Money {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new InvalidMoney(`multiplier must be a non-negative safe integer, got ${count}`);
    }
    return Money.fromCents(this.cents * count);
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}
