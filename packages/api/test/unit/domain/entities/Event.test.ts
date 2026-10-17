import { describe, expect, it } from "vitest";
import { Event } from "../../../../src/domain/entities/Event.js";
import { TicketTier } from "../../../../src/domain/entities/TicketTier.js";
import { InvalidEvent } from "../../../../src/domain/errors/InvalidEvent.js";
import { eventId, tierId, type EventId } from "../../../../src/domain/value-objects/Ids.js";
import { Money } from "../../../../src/domain/value-objects/Money.js";

const startsAt = new Date("2026-12-05T19:30:00.000Z");

function tierOf(event: EventId, id: string): TicketTier {
  return TicketTier.create({
    id: tierId(id),
    eventId: event,
    name: id,
    price: Money.fromCents(2000),
    total: 100,
    remaining: 100,
  });
}

function anEvent(tiers: TicketTier[], at: Date = startsAt): Event {
  return Event.create({
    id: eventId("e-1"),
    name: "Rooftop Jazz Night",
    venue: "The Terrace",
    startsAt: at,
    tiers,
  });
}

describe("Event", () => {
  it("exposes its tiers as a frozen copy", () => {
    const tiers = [tierOf(eventId("e-1"), "general")];
    const event = anEvent(tiers);

    tiers.push(tierOf(eventId("e-1"), "vip"));

    expect(event.tiers).toHaveLength(1);
    expect(Object.isFrozen(event.tiers)).toBe(true);
  });

  it("accepts an event with no tiers yet", () => {
    expect(anEvent([]).tiers).toEqual([]);
  });

  it("rejects a tier that belongs to a different event", () => {
    expect(() => anEvent([tierOf(eventId("e-2"), "general")])).toThrow(InvalidEvent);
  });

  it("does not alias the caller's start instant", () => {
    const at = new Date(startsAt.getTime());
    const event = anEvent([], at);

    at.setFullYear(1970);
    event.startsAt.setFullYear(1970);

    expect(event.startsAt).toEqual(startsAt);
  });
});
