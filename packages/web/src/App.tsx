import type { ReactNode } from "react";
import { Link } from "./components/Link.js";
import { usePath } from "./hooks/usePath.js";
import { EventDetailPage } from "./pages/EventDetailPage.js";
import { EventListPage } from "./pages/EventListPage.js";

const EVENT_PATH = /^\/events\/([^/]+)$/;

function Screen({ path }: { path: string }): ReactNode {
  if (path === "/") return <EventListPage />;
  const event = EVENT_PATH.exec(path);
  const id = event?.[1];
  if (id !== undefined) return <EventDetailPage id={id} />;
  return (
    <p className="status">
      Nothing at <code>{path}</code>. <Link to="/">All events</Link>
    </p>
  );
}

export function App(): ReactNode {
  const path = usePath();
  return (
    <main>
      <header>
        <Link to="/">Ticketbox</Link>
      </header>
      <Screen path={path} />
    </main>
  );
}
