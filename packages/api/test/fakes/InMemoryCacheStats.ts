import type { CacheStatsReader } from "../../src/application/ports/CacheStatsReader.js";
import type { CacheStatsRecorder } from "../../src/infrastructure/redis/CachedEventRepository.js";

export class InMemoryCacheStats implements CacheStatsRecorder, CacheStatsReader {
  hits = 0;
  misses = 0;

  recordHit(): void {
    this.hits += 1;
  }

  recordMiss(): void {
    this.misses += 1;
  }

  async read(): Promise<{ hits: number; misses: number }> {
    return { hits: this.hits, misses: this.misses };
  }
}
