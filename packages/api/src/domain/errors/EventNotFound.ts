import { DomainError } from "./DomainError.js";

export class EventNotFound extends DomainError {
  constructor(id: string) {
    super(`event ${id} not found`);
  }
}
