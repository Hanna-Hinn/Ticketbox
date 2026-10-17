import { z } from "zod";

// What crosses the HTTP boundary, in both directions. These are Fastify's
// route schemas (via fastify-type-provider-zod), so a malformed :id is a 400
// before any handler runs.

export const EventIdParams = z.object({ id: z.uuid() });

export const TierResponse = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.int().nonnegative(),
  total: z.int().nonnegative(),
  remaining: z.int().nonnegative(),
});

export const EventSummaryResponse = z.object({
  id: z.string(),
  name: z.string(),
  venue: z.string(),
  startsAt: z.iso.datetime(),
});

export const EventResponse = EventSummaryResponse.extend({
  tiers: z.array(TierResponse),
});

export const EventListResponse = z.array(EventSummaryResponse);

export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export type EventSummaryDto = z.infer<typeof EventSummaryResponse>;
export type EventDto = z.infer<typeof EventResponse>;
