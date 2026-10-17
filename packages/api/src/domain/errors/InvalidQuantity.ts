import { DomainError } from "./DomainError.js";

export class InvalidQuantity extends DomainError {
  constructor(value: number, max: number) {
    super(`Quantity must be an integer between 1 and ${max}, got ${value}`);
  }
}
