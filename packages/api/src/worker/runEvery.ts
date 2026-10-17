// A tick on an interval, with the two things setInterval alone gets wrong:
// a tick still running when the next is due is skipped, not stacked (two
// overlapping sweeps in one process are safe, and pointless), and a tick
// that throws reaches onError instead of being an unhandled rejection that
// takes the worker down. Returns the way to stop.
export function runEvery(
  intervalMs: number,
  tick: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
