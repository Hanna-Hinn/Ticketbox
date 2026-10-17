import { InvalidEvent } from "../errors/InvalidEvent.js";
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
  readonly tiers: readonly TicketTier[];
  private readonly startsAtMs: number;

  private constructor(props: EventProps) {
    this.id = props.id;
    this.name = props.name;
    this.venue = props.venue;
    this.startsAtMs = props.startsAt.getTime();
    // A copy, frozen: `readonly T[]` is a type, and the caller still holds
    // the original array.
    this.tiers = Object.freeze([...props.tiers]);
  }

  static create(props: EventProps): Event {
    const stray = props.tiers.find((tier) => tier.eventId !== props.id);
    if (stray !== undefined) {
      throw new InvalidEvent(`tier ${stray.id} belongs to event ${stray.eventId}, not ${props.id}`);
    }
    return new Event(props);
  }

  get startsAt(): Date {
    return new Date(this.startsAtMs);
  }
}
