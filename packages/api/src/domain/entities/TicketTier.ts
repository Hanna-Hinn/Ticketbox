import { InvalidTicketTier } from "../errors/InvalidTicketTier.js";
import type { EventId, TierId } from "../value-objects/Ids.js";
import type { Money } from "../value-objects/Money.js";
import type { Quantity } from "../value-objects/Quantity.js";

export interface TicketTierProps {
  readonly id: TierId;
  readonly eventId: EventId;
  readonly name: string;
  readonly price: Money;
  readonly total: number;
  // total − sold − currently held (handbook §1.5). Computed by whoever loads
  // the tier; never negative, never above total.
  readonly remaining: number;
}

export class TicketTier {
  readonly id: TierId;
  readonly eventId: EventId;
  readonly name: string;
  readonly price: Money;
  readonly total: number;
  readonly remaining: number;

  private constructor(props: TicketTierProps) {
    this.id = props.id;
    this.eventId = props.eventId;
    this.name = props.name;
    this.price = props.price;
    this.total = props.total;
    this.remaining = props.remaining;
  }

  static create(props: TicketTierProps): TicketTier {
    if (!Number.isInteger(props.total) || props.total < 0) {
      throw new InvalidTicketTier(`total must be a non-negative integer, got ${props.total}`);
    }
    if (
      !Number.isInteger(props.remaining) ||
      props.remaining < 0 ||
      props.remaining > props.total
    ) {
      throw new InvalidTicketTier(
        `remaining must be an integer between 0 and total (${props.total}), got ${props.remaining}`,
      );
    }
    return new TicketTier(props);
  }

  canFulfil(qty: Quantity): boolean {
    return qty.value <= this.remaining;
  }
}
