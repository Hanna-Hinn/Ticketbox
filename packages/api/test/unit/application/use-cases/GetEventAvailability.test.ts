import { describe, expect, it } from "vitest";
import { GetEventAvailabilityUseCase } from "../../../../src/application/use-cases/GetEventAvailability.js";
import { eventId, tierId } from "../../../../src/domain/value-objects/Ids.js";
import { aTier, anEvent, DEFAULT_EVENT_ID } from "../../../fakes/builders.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryHoldStore } from "../../../fakes/InMemoryHoldStore.js";

const GENERAL = tierId("general");
const VIP = tierId("vip");

function world() {
  const events = new InMemoryEventRepository([
    anEvent()
      .withTiers([
        aTier().withId("general").withRemaining(10).build(),
        aTier().withId("vip").withRemaining(3).build(),
      ])
      .build(),
  ]);
  const holds = new InMemoryHoldStore(new FakeClock("2026-01-01T00:00:00.000Z"));
  return { useCase: new GetEventAvailabilityUseCase(events, holds), holds };
}

describe("GetEventAvailabilityUseCase", () => {
  it("returns the event with its tiers as plain data", async () => {
    const { useCase } = world();

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result).toEqual({
      ok: true,
      event: {
        id: DEFAULT_EVENT_ID,
        name: "Rooftop Jazz Night",
        venue: "The Terrace",
        startsAt: new Date("2026-12-05T19:30:00.000Z"),
        tiers: [
          { id: GENERAL, name: "General", priceCents: 2000, total: 100, remaining: 10 },
          { id: VIP, name: "General", priceCents: 2000, total: 100, remaining: 3 },
        ],
      },
    });
  });

  it("shows the live count for a tier the store knows, including zero", async () => {
    const { useCase, holds } = world();
    holds.seed(GENERAL, 0);

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.event.tiers.map((tier) => tier.remaining)).toEqual([0, 3]);
  });

  it("falls back to the computed count only for tiers the store has never seen", async () => {
    const { useCase, holds } = world();
    holds.seed(GENERAL, 7);

    const result = await useCase.execute({ eventId: DEFAULT_EVENT_ID });

    expect(result.ok && result.event.tiers.map((tier) => tier.remaining)).toEqual([7, 3]);
  });

  it("reports an unknown event as a value, not an error", async () => {
    const { useCase } = world();

    const result = await useCase.execute({ eventId: eventId("no-such-event") });

    expect(result).toEqual({ ok: false, reason: "unknown-event" });
  });
});
