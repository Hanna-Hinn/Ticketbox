import type { EventId, TierId } from "../../domain/value-objects/Ids.js";

export interface AvailabilityChange {
  readonly eventId: EventId;
  readonly tierId: TierId;
  readonly remaining: number;
}

// The use case announces that a tier's availability moved, without knowing
// whether that is Pub/Sub, a Stream, or nothing at all. One method, not one
// per cause: a hold created, released or swept all produce the same payload,
// and subscribers only ever consume the effect ("tier X now has N left").
export interface EventPublisher {
  availabilityChanged(change: AvailabilityChange): Promise<void>;
}
