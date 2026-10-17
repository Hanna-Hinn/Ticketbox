import { Event } from "../../src/domain/entities/Event.js";
import { TicketTier } from "../../src/domain/entities/TicketTier.js";
import { eventId, tierId, type EventId } from "../../src/domain/value-objects/Ids.js";
import { Money } from "../../src/domain/value-objects/Money.js";

// aTier().withRemaining(10).build() — forty lines of setup per test is how
// tests stop being read.

export const DEFAULT_EVENT_ID: EventId = eventId("11111111-1111-4111-8111-111111111111");

class TierBuilder {
  private id = "11111111-1111-4111-8111-aaaaaaaaaaaa";
  private event: EventId = DEFAULT_EVENT_ID;
  private name = "General";
  private priceCents = 2000;
  private total = 100;
  private remaining = 10;

  withId(id: string): this {
    this.id = id;
    return this;
  }

  forEvent(id: EventId): this {
    this.event = id;
    return this;
  }

  withName(name: string): this {
    this.name = name;
    return this;
  }

  withPriceCents(cents: number): this {
    this.priceCents = cents;
    return this;
  }

  withTotal(total: number): this {
    this.total = total;
    return this;
  }

  withRemaining(remaining: number): this {
    this.remaining = remaining;
    return this;
  }

  build(): TicketTier {
    return TicketTier.create({
      id: tierId(this.id),
      eventId: this.event,
      name: this.name,
      price: Money.fromCents(this.priceCents),
      total: this.total,
      remaining: this.remaining,
    });
  }
}

class EventBuilder {
  private id: EventId = DEFAULT_EVENT_ID;
  private name = "Rooftop Jazz Night";
  private venue = "The Terrace";
  private startsAt = new Date("2026-12-05T19:30:00.000Z");
  private tiers: TicketTier[] = [];

  withId(id: string): this {
    this.id = eventId(id);
    return this;
  }

  withName(name: string): this {
    this.name = name;
    return this;
  }

  startingAt(at: string | Date): this {
    this.startsAt = new Date(at);
    return this;
  }

  withTiers(tiers: readonly TicketTier[]): this {
    this.tiers = [...tiers];
    return this;
  }

  build(): Event {
    return Event.create({
      id: this.id,
      name: this.name,
      venue: this.venue,
      startsAt: this.startsAt,
      tiers: this.tiers,
    });
  }
}

export function aTier(): TierBuilder {
  return new TierBuilder();
}

export function anEvent(): EventBuilder {
  return new EventBuilder();
}
