import type { OrderId } from "../../domain/value-objects/Ids.js";

// Never crypto.randomUUID() inside a use case: tests want predictable ids.
export interface OrderIdGenerator {
  nextOrderId(): OrderId;
}
