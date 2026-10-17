// A Redis command under a deadline. A command already on the wire when the
// socket dies is re-sent by ioredis after the reconnect and rejected only
// after maxRetriesPerRequest attempts (~74 s with TB-017's defaults); the
// client's status cannot see that, a deadline can. The dangling command
// settles on its own later; nothing here waits for it.
// A healthy local GET is ~1 ms and the fallback (Postgres, indexed) ~23 ms;
// a cache read that takes longer than the fallback has stopped being one.
export const CACHE_COMMAND_DEADLINE_MS = 100;
// A socket that is "ready" and not answering (half-open TCP, a BUSY server)
// would hold a POST /holds for as long as the OS takes to notice; the write
// path (holds, TB-022; idempotency claims, TB-030) gets a deadline too,
// wider than the cache's because a script that ran but whose reply was
// lost is not "did not happen" — it is a hold with nobody holding its
// token, bounded by the TTL (TB-022 plan §6), or a claim nobody completes,
// bounded by its day (ADR 0008).
export const WRITE_COMMAND_DEADLINE_MS = 1_000;

export async function within<T>(
  command: Promise<T>,
  ms: number,
  what = "cache command",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([command, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
