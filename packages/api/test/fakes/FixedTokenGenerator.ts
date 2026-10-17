import type { OrderIdGenerator } from "../../src/application/ports/OrderIdGenerator.js";
import type { TokenGenerator } from "../../src/application/ports/TokenGenerator.js";
import { holdToken, type HoldToken } from "../../src/domain/value-objects/HoldToken.js";
import { orderId, type OrderId } from "../../src/domain/value-objects/Ids.js";

// Hands out the tokens it was given, in order, and refuses to invent more:
// a test that creates a hold it did not plan for should fail loudly.
export class FixedTokenGenerator implements TokenGenerator, OrderIdGenerator {
  private readonly queue: string[];

  constructor(tokens: readonly string[]) {
    this.queue = [...tokens];
  }

  next(): HoldToken {
    return holdToken(this.take());
  }

  nextOrderId(): OrderId {
    return orderId(this.take());
  }

  private take(): string {
    const value = this.queue.shift();
    if (value === undefined) throw new Error("FixedTokenGenerator ran out of tokens");
    return value;
  }
}
