import type { GetEventAvailabilityUseCase } from "../../../application/use-cases/GetEventAvailability.js";
import type { ListUpcomingEventsUseCase } from "../../../application/use-cases/ListUpcomingEvents.js";
import { eventId } from "../../../domain/value-objects/Ids.js";
import type { EventDto, EventSummaryDto } from "../../dto/events.js";
import { toEventDto, toEventSummaryDto } from "../../mappers/events.js";

// Map in, call one use case, map out. No Fastify type on either side, and
// no decision about the domain: an unknown event is `null`, and what null
// means over HTTP is the route's business.
export class EventController {
  constructor(
    private readonly listUpcoming: ListUpcomingEventsUseCase,
    private readonly getAvailability: GetEventAvailabilityUseCase,
  ) {}

  async list(): Promise<EventSummaryDto[]> {
    const summaries = await this.listUpcoming.execute();
    return summaries.map(toEventSummaryDto);
  }

  async get(id: string): Promise<EventDto | null> {
    const result = await this.getAvailability.execute({ eventId: eventId(id) });
    return result.ok ? toEventDto(result.event) : null;
  }
}
