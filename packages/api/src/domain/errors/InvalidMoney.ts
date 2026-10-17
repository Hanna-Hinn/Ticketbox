import { DomainError } from "./DomainError.js";

export class InvalidMoney extends DomainError {
  constructor(value: number) {
    super(`Money must be a non-negative integer number of cents, got ${value}`);
  }
}
