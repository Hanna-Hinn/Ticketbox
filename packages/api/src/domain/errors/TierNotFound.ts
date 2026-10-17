import { DomainError } from "./DomainError.js";

export class TierNotFound extends DomainError {
  constructor(id: string) {
    super(`tier ${id} not found`);
  }
}
