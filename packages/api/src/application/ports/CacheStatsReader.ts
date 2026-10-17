// What the application needs to know about the cache: two counters. How
// they are kept (INCR in Redis, TB-019) is the adapter's business.
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
}

export interface CacheStatsReader {
  read(): Promise<CacheStats>;
}
