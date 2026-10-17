import type { GetEventAvailabilityUseCase } from "../../../application/use-cases/GetEventAvailability.js";
import type { ListUpcomingEventsUseCase } from "../../../application/use-cases/ListUpcomingEvents.js";
import { EventNotFound } from "../../../domain/errors/EventNotFound.js";
import { eventId } from "../../../domain/value-objects/Ids.js";
import type { EventDto, EventSummaryDto } from "../../dto/events.js";
import { toEventDto, toEventSummaryDto } from "../../mappers/events.js";

// Map in, call one use case, map out. No Fastify type on either side, and
// no decision about the domain: the use case said "unknown event", and the
// only place that becomes an HTTP status is the error handler.
export class EventController {
  constructor(
    private readonly listUpcoming: ListUpcomingEventsUseCase,
    private readonly getAvailability: GetEventAvailabilityUseCase,
  ) {}

  async list(): Promise<EventSummaryDto[]> {
    const summaries = await this.listUpcoming.execute();
    return summaries.map(toEventSummaryDto);
  }

  async get(id: string): Promise<EventDto> {
    const result = await this.getAvailability.execute({ eventId: eventId(id) });
    if (!result.ok) throw new EventNotFound(id);
    return toEventDto(result.event);
  }
}
