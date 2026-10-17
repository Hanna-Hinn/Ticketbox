import type { GetCacheStatsUseCase } from "../../../application/use-cases/GetCacheStats.js";
import type { StatsDto } from "../../dto/stats.js";

export class StatsController {
  constructor(private readonly getCacheStats: GetCacheStatsUseCase) {}

  async get(): Promise<StatsDto> {
    const cache = await this.getCacheStats.execute();
    return { cache: { hits: cache.hits, misses: cache.misses, hitRatio: cache.hitRatio } };
  }
}
