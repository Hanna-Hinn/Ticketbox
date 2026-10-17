import { useEffect, useState } from "react";

// Two routes and one dynamic segment do not need a router package: the
// pathname is the state, pushState changes it, popstate follows the back
// button. The first screen that needs nested routes replaces this file.

const listeners = new Set<() => void>();

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  for (const notify of listeners) notify();
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = (): void => setPath(window.location.pathname);
    listeners.add(sync);
    window.addEventListener("popstate", sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return path;
}
