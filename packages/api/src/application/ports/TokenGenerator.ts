import type { HoldToken } from "../../domain/value-objects/HoldToken.js";

// Never crypto.randomUUID() inside a use case: tests want predictable tokens.
export interface TokenGenerator {
  next(): HoldToken;
}
