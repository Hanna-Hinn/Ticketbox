import type { TokenGenerator } from "../../src/application/ports/TokenGenerator.js";
import { holdToken, type HoldToken } from "../../src/domain/value-objects/HoldToken.js";

// Hands out the tokens it was given, in order, and refuses to invent more:
// a test that creates a hold it did not plan for should fail loudly.
export class FixedTokenGenerator implements TokenGenerator {
  private readonly queue: string[];

  constructor(tokens: readonly string[]) {
    this.queue = [...tokens];
  }

  next(): HoldToken {
    const token = this.queue.shift();
    if (token === undefined) throw new Error("FixedTokenGenerator ran out of tokens");
    return holdToken(token);
  }
}
