// A Redis command under a deadline. A command already on the wire when the
// socket dies is re-sent by ioredis after the reconnect and rejected only
// after maxRetriesPerRequest attempts (~74 s with TB-017's defaults); the
// client's status cannot see that, a deadline can. The dangling command
// settles on its own later; nothing here waits for it.
// A healthy local GET is ~1 ms and the fallback (Postgres, indexed) ~23 ms;
// a cache read that takes longer than the fallback has stopped being one.
export const CACHE_COMMAND_DEADLINE_MS = 100;

export async function within<T>(command: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache command exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([command, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
