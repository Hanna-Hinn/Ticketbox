import { CreateHoldUseCase } from "../../../src/application/use-cases/CreateHold.js";
import { GetCacheStatsUseCase } from "../../../src/application/use-cases/GetCacheStats.js";
import { GetEventAvailabilityUseCase } from "../../../src/application/use-cases/GetEventAvailability.js";
import { GetHoldUseCase } from "../../../src/application/use-cases/GetHold.js";
import { ListUpcomingEventsUseCase } from "../../../src/application/use-cases/ListUpcomingEvents.js";
import { ReleaseHoldUseCase } from "../../../src/application/use-cases/ReleaseHold.js";
import { EventController } from "../../../src/presentation/http/controllers/EventController.js";
import { HoldController } from "../../../src/presentation/http/controllers/HoldController.js";
import { StatsController } from "../../../src/presentation/http/controllers/StatsController.js";
import { FakeClock } from "../../fakes/FakeClock.js";
import { FixedTokenGenerator } from "../../fakes/FixedTokenGenerator.js";
import { InMemoryCacheStats } from "../../fakes/InMemoryCacheStats.js";
import { InMemoryEventRepository } from "../../fakes/InMemoryEventRepository.js";
import { InMemoryHoldRepository } from "../../fakes/InMemoryHoldRepository.js";
import { InMemoryHoldStore } from "../../fakes/InMemoryHoldStore.js";

// A route test exercises one controller; the server still needs the other
// two. These are the controllers over empty fakes that nothing calls.
const START = "2026-01-01T00:00:00.000Z";

export function unusedEventController(): EventController {
  const noEvents = new InMemoryEventRepository([]);
  return new EventController(
    new ListUpcomingEventsUseCase(noEvents, new FakeClock(START)),
    new GetEventAvailabilityUseCase(noEvents, new InMemoryHoldStore(new FakeClock(START))),
  );
}

export function unusedHoldController(): HoldController {
  const clock = new FakeClock(START);
  const holds = new InMemoryHoldStore(clock);
  const mirror = new InMemoryHoldRepository();
  return new HoldController(
    new CreateHoldUseCase(
      new InMemoryEventRepository([]),
      holds,
      mirror,
      clock,
      new FixedTokenGenerator([]),
      120_000,
    ),
    new GetHoldUseCase(holds, clock),
    new ReleaseHoldUseCase(holds, mirror),
  );
}

export function unusedStatsController(): StatsController {
  return new StatsController(new GetCacheStatsUseCase(new InMemoryCacheStats()));
}
