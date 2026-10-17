import { useCallback, useEffect, useState } from "react";

// One loading / loaded / error state machine for both pages. The browser
// renders what the API said; an unmounted page ignores a late response.
// TB-015 moves the fetch itself behind the typed client.

export type FetchState<T> =
  { status: "loading" } | { status: "loaded"; data: T } | { status: "error"; message: string };

export function useFetch<T>(url: string): { state: FetchState<T>; retry: () => void } {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    // Every write goes through the guard: a cleaned-up effect (unmount, url
    // change, StrictMode's first run) must not touch state on any path,
    // including a body read that was aborted inside describeError.
    const settle = (next: FetchState<T>): void => {
      if (!controller.signal.aborted) setState(next);
    };
    setState({ status: "loading" });

    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          settle({ status: "error", message: await describeError(response) });
          return;
        }
        // The API's Zod serializer guarantees the shape on its side; TB-015
        // adds the client-side parse.
        settle({ status: "loaded", data: (await response.json()) as T });
      })
      .catch((err: unknown) => {
        settle({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });

    return () => controller.abort();
  }, [url, attempt]);

  return { state, retry };
}

// The API's error envelope is { error: { code, message } } (TB-012); anything
// else is reported by status alone.
async function describeError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const message =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
      ? body.error.message
      : response.statusText;
  return `${response.status} ${message}`;
}
