import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../hooks/usePath.js";

// A real <a> (middle-click and "open in new tab" keep working); a plain
// left-click becomes an in-app navigation instead of a full reload.
export function Link({ to, children }: { to: string; children: ReactNode }): ReactNode {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  );
}
