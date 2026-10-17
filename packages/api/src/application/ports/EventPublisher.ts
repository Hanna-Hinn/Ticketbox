import type { EventId, TierId } from "../../domain/value-objects/Ids.js";

export interface AvailabilityChange {
  readonly eventId: EventId;
  readonly tierId: TierId;
  readonly remaining: number;
}

// The use case announces "hold created" without knowing whether that is
// Pub/Sub, a Stream, or nothing at all. The payload is what a subscriber
// needs: tier X now has N left.
export interface EventPublisher {
  holdCreated(change: AvailabilityChange): Promise<void>;
}
