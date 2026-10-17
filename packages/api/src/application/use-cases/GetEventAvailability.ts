import type { EventId, TierId } from "../../domain/value-objects/Ids.js";
import type { EventRepository } from "../ports/EventRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";

export interface GetEventAvailabilityInput {
  readonly eventId: EventId;
}

export interface TierAvailability {
  readonly id: TierId;
  readonly name: string;
  readonly priceCents: number;
  readonly total: number;
  readonly remaining: number;
}

export interface EventAvailability {
  readonly id: EventId;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: Date;
  readonly tiers: readonly TierAvailability[];
}

export type GetEventAvailabilityOutput =
  { ok: true; event: EventAvailability } | { ok: false; reason: "unknown-event" };

export class GetEventAvailabilityUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly holds: HoldStore,
  ) {}

  async execute(input: GetEventAvailabilityInput): Promise<GetEventAvailabilityOutput> {
    const event = await this.events.findById(input.eventId);
    if (event === null) return { ok: false, reason: "unknown-event" };

    // The store is the authority on what is happening now; the repository's
    // number is the computed fallback for a tier the store has never seen
    // (before the live counter exists, or after it was lost).
    const live = await this.holds.availability(event.tiers.map((tier) => tier.id));

    return {
      ok: true,
      event: {
        id: event.id,
        name: event.name,
        venue: event.venue,
        startsAt: event.startsAt,
        tiers: event.tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          priceCents: tier.price.cents,
          total: tier.total,
          remaining: live.get(tier.id) ?? tier.remaining,
        })),
      },
    };
  }
}
