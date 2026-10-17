import { DomainError } from "./DomainError.js";

export class InsufficientInventory extends DomainError {
  constructor(tierId: string) {
    super(`not enough tickets left in tier ${tierId}`);
  }
}
