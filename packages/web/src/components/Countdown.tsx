import { useEffect, useState, type ReactNode } from "react";

// Display only. It counts down to the server's instant and, at zero, says so
// once; the page then asks the server, which is the authority on whether the
// hold is alive. Date.now() here is arithmetic for the display, not a
// decision — a skewed clock shows a wrong number and still ends in a
// re-fetch.
export function Countdown({
  expiresAt,
  onZero,
}: {
  expiresAt: string;
  onZero: () => void;
}): ReactNode {
  const [remainingMs, setRemainingMs] = useState(() => remainingUntil(expiresAt));

  useEffect(() => {
    let reached = false;
    const tick = (): void => {
      const left = remainingUntil(expiresAt);
      setRemainingMs(left);
      if (left === 0 && !reached) {
        reached = true;
        onZero();
      }
    };
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
    // onZero is the page's re-fetch; the expiry is what the clock runs on.
  }, [expiresAt]);

  return (
    <p className="countdown" data-testid="countdown" aria-live="polite">
      {format(remainingMs)}
    </p>
  );
}

function remainingUntil(iso: string): number {
  return Math.max(0, new Date(iso).getTime() - Date.now());
}

function format(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
