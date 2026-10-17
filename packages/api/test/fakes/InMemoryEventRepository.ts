import type { EventRepository } from "../../src/application/ports/EventRepository.js";
import type { Event } from "../../src/domain/entities/Event.js";
import type { EventId } from "../../src/domain/value-objects/Ids.js";

export class InMemoryEventRepository implements EventRepository {
  private readonly events: ReadonlyMap<EventId, Event>;

  constructor(events: readonly Event[]) {
    this.events = new Map(events.map((event) => [event.id, event]));
  }

  async findById(id: EventId): Promise<Event | null> {
    return this.events.get(id) ?? null;
  }

  async listUpcoming(now: Date): Promise<readonly Event[]> {
    return [...this.events.values()].filter((event) => event.startsAt.getTime() > now.getTime());
  }
}
