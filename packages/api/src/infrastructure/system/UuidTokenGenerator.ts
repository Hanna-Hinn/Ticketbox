import { randomUUID } from "node:crypto";
import type { TokenGenerator } from "../../application/ports/TokenGenerator.js";
import { holdToken, type HoldToken } from "../../domain/value-objects/HoldToken.js";

// A v4 UUID from the platform's CSPRNG: unguessable, and the shape the
// route's z.uuid() admits.
export class UuidTokenGenerator implements TokenGenerator {
  next(): HoldToken {
    return holdToken(randomUUID());
  }
}
