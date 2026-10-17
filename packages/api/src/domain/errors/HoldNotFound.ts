import { DomainError } from "./DomainError.js";

// Expired, released or never issued: one answer, as it is one answer in the
// store.
export class HoldNotFound extends DomainError {
  constructor(token: string) {
    super(`hold ${token} not found`);
  }
}
