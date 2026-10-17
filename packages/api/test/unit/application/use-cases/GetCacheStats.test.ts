import { describe, expect, it } from "vitest";
import { GetCacheStatsUseCase } from "../../../../src/application/use-cases/GetCacheStats.js";
import { InMemoryCacheStats } from "../../../fakes/InMemoryCacheStats.js";

describe("GetCacheStatsUseCase", () => {
  it("reports the counters and the hit ratio", async () => {
    const stats = new InMemoryCacheStats();
    stats.hits = 3;
    stats.misses = 1;

    const output = await new GetCacheStatsUseCase(stats).execute();

    expect(output).toEqual({ hits: 3, misses: 1, hitRatio: 0.75 });
  });

  it("reports a ratio of zero, not NaN, before the first lookup", async () => {
    const output = await new GetCacheStatsUseCase(new InMemoryCacheStats()).execute();

    expect(output).toEqual({ hits: 0, misses: 0, hitRatio: 0 });
  });
});
