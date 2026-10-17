import { useEffect, useRef, useState, type ReactNode } from "react";

// Display only. The server said how long is left; Date.now() here measures
// only the time elapsed since that answer arrived, never the distance to an
// absolute instant — a browser clock ahead of the server would otherwise
// read zero at once, re-fetch, be told "alive", and ask again as fast as
// the network allows. Zero is reached no earlier than the server's own
// expiry, then the page asks once; the server decides.
export function Countdown({
  remainingMs,
  onZero,
}: {
  remainingMs: number;
  onZero: () => void;
}): ReactNode {
  const [deadline] = useState(() => Date.now() + remainingMs);
  const [left, setLeft] = useState(remainingMs);
  const onZeroRef = useRef(onZero);
  onZeroRef.current = onZero;

  useEffect(() => {
    const interval = window.setInterval(() => {
      const ms = Math.max(0, deadline - Date.now());
      setLeft(ms);
      if (ms === 0) {
        // Once per expiry, by construction: the interval dies with the call.
        window.clearInterval(interval);
        onZeroRef.current();
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [deadline]);

  return (
    <p className="countdown" data-testid="countdown" aria-live="polite">
      {format(left)}
    </p>
  );
}

function format(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
