import type { RedisStatus } from "ioredis";
import type { CacheClient } from "../../src/infrastructure/redis/CachedEventRepository.js";

// The subset of Redis the cache-aside decorator uses, on a Map. `status`,
// `failing` and `hanging` are settable so a test can play a reconnecting,
// a broken, or a silent client without Docker.
export interface CacheEntry {
  value: string;
  ttlSeconds?: number;
  ttlMs?: number;
}

export class InMemoryCache implements CacheClient {
  status: RedisStatus = "ready";
  failing = false;
  // A command that never settles: the in-flight-when-Redis-died case.
  hanging = false;
  readonly entries = new Map<string, CacheEntry>();

  async get(key: string): Promise<string | null> {
    this.failIfBroken();
    if (this.hanging) return never();
    return this.entries.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    token: "EX" | "PX",
    amount: number,
    nx?: "NX",
  ): Promise<"OK" | null> {
    this.failIfBroken();
    if (this.hanging) return never();
    if (nx === "NX" && this.entries.has(key)) return null;
    this.entries.set(
      key,
      token === "EX" ? { value, ttlSeconds: amount } : { value, ttlMs: amount },
    );
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.failIfBroken();
    if (this.hanging) return never();
    return this.entries.delete(key) ? 1 : 0;
  }

  private failIfBroken(): void {
    if (this.failing) throw new Error("Connection is closed.");
  }
}

// A promise that never settles.
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
