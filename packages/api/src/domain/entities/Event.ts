import type { EventId } from "../value-objects/Ids.js";
import type { TicketTier } from "./TicketTier.js";

export interface EventProps {
  readonly id: EventId;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly tiers: readonly TicketTier[];
}

export class Event {
  readonly id: EventId;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly tiers: readonly TicketTier[];

  private constructor(props: EventProps) {
    this.id = props.id;
    this.name = props.name;
    this.venue = props.venue;
    this.startsAt = props.startsAt;
    this.tiers = props.tiers;
  }

  static create(props: EventProps): Event {
    return new Event(props);
  }
}
