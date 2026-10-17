import { InvalidMoney } from "../errors/InvalidMoney.js";

// Integer cents, one currency, never a float. 0.1 + 0.2 is not 0.3 in IEEE
// 754, and a box office that is off by a cent is a box office with a bug.
export class Money {
  private constructor(readonly cents: number) {}

  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents) || cents < 0) throw new InvalidMoney(cents);
    return new Money(cents);
  }

  static zero(): Money {
    return new Money(0);
  }

  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  times(count: number): Money {
    if (!Number.isInteger(count) || count < 0) throw new InvalidMoney(count);
    return new Money(this.cents * count);
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}
