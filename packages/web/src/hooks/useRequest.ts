import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client.js";

// One loading / loaded / error state machine for every page. `load` is a
// closure over a client call; `key` is what the effect re-runs on (the event
// id, "" for the list), so `load` itself is deliberately not a dependency.

export type RequestState<T> =
  { status: "loading" } | { status: "loaded"; data: T } | { status: "error"; message: string };

export function useRequest<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): { state: RequestState<T>; retry: () => void } {
  const [state, setState] = useState<RequestState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    // Every write goes through the guard: a cleaned-up effect (unmount, key
    // change, StrictMode's first run) must not touch state on any path.
    const settle = (next: RequestState<T>): void => {
      if (!controller.signal.aborted) setState(next);
    };
    setState({ status: "loading" });

    load(controller.signal)
      .then((data) => settle({ status: "loaded", data }))
      .catch((err: unknown) => settle({ status: "error", message: describe(err) }));

    return () => controller.abort();
  }, [key, attempt]);

  return { state, retry };
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
