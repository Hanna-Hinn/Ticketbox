import { DomainError } from "./DomainError.js";

// The hold existed and will not again: expired, released, or already
// confirmed. The store cannot tell which, and the customer is told the
// same thing either way.
export class HoldGone extends DomainError {
  constructor(token: string) {
    super(`hold ${token} is gone`);
  }
}
