import { randomUUID } from "node:crypto";
import type { OrderIdGenerator } from "../../application/ports/OrderIdGenerator.js";
import type { TokenGenerator } from "../../application/ports/TokenGenerator.js";
import { holdToken, type HoldToken } from "../../domain/value-objects/HoldToken.js";
import { orderId, type OrderId } from "../../domain/value-objects/Ids.js";

// A v4 UUID from the platform's CSPRNG: unguessable, and the shape the
// route's z.uuid() admits.
// Two ports, one source: an order id is the same kind of thing as a token.
export class UuidTokenGenerator implements TokenGenerator, OrderIdGenerator {
  next(): HoldToken {
    return holdToken(randomUUID());
  }

  nextOrderId(): OrderId {
    return orderId(randomUUID());
  }
}
