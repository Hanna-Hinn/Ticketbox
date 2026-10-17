import { DomainError } from "./DomainError.js";

// A second order with a key an order already carries. Until TB-030 answers
// the retry with the first order, the constraint refuses it (TB-029).
export class IdempotencyKeyReused extends DomainError {
  constructor() {
    super("idempotency key already used by another order");
  }
}
