import type { CacheStatsReader } from "../ports/CacheStatsReader.js";

export interface CacheStatsOutput {
  readonly hits: number;
  readonly misses: number;
  // hits / (hits + misses); 0 before the first read, never NaN.
  readonly hitRatio: number;
}

export class GetCacheStatsUseCase {
  constructor(private readonly stats: CacheStatsReader) {}

  async execute(): Promise<CacheStatsOutput> {
    const { hits, misses } = await this.stats.read();
    const total = hits + misses;
    return { hits, misses, hitRatio: total === 0 ? 0 : hits / total };
  }
}
