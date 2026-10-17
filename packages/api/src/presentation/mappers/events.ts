import type { EventAvailability } from "../../application/use-cases/GetEventAvailability.js";
import type { EventSummary } from "../../application/use-cases/ListUpcomingEvents.js";
import type { EventDto, EventSummaryDto } from "../dto/events.js";

export function toEventSummaryDto(summary: EventSummary): EventSummaryDto {
  return {
    id: summary.id,
    name: summary.name,
    venue: summary.venue,
    startsAt: summary.startsAt.toISOString(),
  };
}

export function toEventDto(event: EventAvailability): EventDto {
  return {
    id: event.id,
    name: event.name,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    tiers: event.tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      priceCents: tier.priceCents,
      total: tier.total,
      remaining: tier.remaining,
    })),
  };
}
