import type { ReactNode } from "react";
import { Link } from "./components/Link.js";
import { usePath } from "./hooks/usePath.js";
import { EventDetailPage } from "./pages/EventDetailPage.js";
import { CheckoutPage } from "./pages/CheckoutPage.js";
import { EventListPage } from "./pages/EventListPage.js";

const EVENT_PATH = /^\/events\/([^/]+)$/;
const CHECKOUT_PATH = /^\/checkout\/([^/]+)$/;

function Screen({ path }: { path: string }): ReactNode {
  if (path === "/") return <EventListPage />;
  const event = EVENT_PATH.exec(path);
  const id = event?.[1];
  // key: /events/a → /events/b remounts instead of showing a's data under b's URL.
  if (id !== undefined) return <EventDetailPage key={id} id={id} />;
  const token = CHECKOUT_PATH.exec(path)?.[1];
  if (token !== undefined) return <CheckoutPage key={token} token={token} />;
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
