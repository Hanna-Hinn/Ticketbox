import type { EventId } from "../../domain/value-objects/Ids.js";
import type { Clock } from "../ports/Clock.js";
import type { EventRepository } from "../ports/EventRepository.js";

export interface EventSummary {
  readonly id: EventId;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: Date;
}

// The list page shows cards, not tiers: summaries only.
export class ListUpcomingEventsUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<readonly EventSummary[]> {
    const events = await this.events.listUpcoming(this.clock.now());
    return events.map((event) => ({
      id: event.id,
      name: event.name,
      venue: event.venue,
      startsAt: event.startsAt,
    }));
  }
}
