import type { ReactNode } from "react";

export function Loading(): ReactNode {
  return <p className="status">Loading…</p>;
}

export function ErrorMessage({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}): ReactNode {
  return (
    <p className="status error" role="alert">
      Could not load: {message}{" "}
      <button type="button" onClick={retry}>
        Try again
      </button>
    </p>
  );
}
