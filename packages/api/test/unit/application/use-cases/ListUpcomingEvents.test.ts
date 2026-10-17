import { describe, expect, it } from "vitest";
import { ListUpcomingEventsUseCase } from "../../../../src/application/use-cases/ListUpcomingEvents.js";
import { aTier, anEvent } from "../../../fakes/builders.js";
import { FakeClock } from "../../../fakes/FakeClock.js";
import { InMemoryEventRepository } from "../../../fakes/InMemoryEventRepository.js";

describe("ListUpcomingEventsUseCase", () => {
  const events = new InMemoryEventRepository([
    anEvent()
      .withId("e-dec")
      .startingAt("2026-12-05T19:30:00.000Z")
      .withTiers([aTier().forEvent("e-dec").build()])
      .build(),
    anEvent().withId("e-jan").startingAt("2027-01-10T20:00:00.000Z").build(),
  ]);

  it("lists only events after the injected clock's instant, as summaries without tiers", async () => {
    const useCase = new ListUpcomingEventsUseCase(
      events,
      new FakeClock("2026-12-10T00:00:00.000Z"),
    );

    const result = await useCase.execute();

    expect(result).toEqual([
      {
        id: "e-jan",
        name: "Rooftop Jazz Night",
        venue: "The Terrace",
        startsAt: new Date("2027-01-10T20:00:00.000Z"),
      },
    ]);
  });

  it("lists everything when the clock is before every event", async () => {
    const useCase = new ListUpcomingEventsUseCase(
      events,
      new FakeClock("2026-01-01T00:00:00.000Z"),
    );

    expect((await useCase.execute()).map((e) => e.id)).toEqual(["e-dec", "e-jan"]);
  });
});
