import { Redis } from "ioredis";

// Integration tests own Redis DB index 9 on the server REDIS_URL names and
// FLUSHDB it before every test (handbook §4.1). The application client never
// selects a DB; the URL built here does, so a flush can only ever hit 9.
const DEFAULT_REDIS_URL = "redis://localhost:6379";
const TEST_DB = 9;

export function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? DEFAULT_REDIS_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

export async function connectToTestRedis(): Promise<Redis> {
  const client = new Redis(testRedisUrl(), { lazyConnect: true });
  await client.connect();
  return client;
}
