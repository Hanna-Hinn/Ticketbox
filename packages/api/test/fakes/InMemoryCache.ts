import type { CacheClient } from "../../src/infrastructure/redis/CachedEventRepository.js";

// The subset of Redis the cache-aside decorator uses, on a Map. `status`
// and `failing` are settable so a test can play a reconnecting or a broken
// client without Docker.
export class InMemoryCache implements CacheClient {
  status = "ready";
  failing = false;
  readonly entries = new Map<string, { value: string; ttlSeconds: number }>();

  async get(key: string): Promise<string | null> {
    this.failIfBroken();
    return this.entries.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _token: "EX", seconds: number): Promise<"OK"> {
    this.failIfBroken();
    this.entries.set(key, { value, ttlSeconds: seconds });
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.failIfBroken();
    return this.entries.delete(key) ? 1 : 0;
  }

  private failIfBroken(): void {
    if (this.failing) throw new Error("Connection is closed.");
  }
}
