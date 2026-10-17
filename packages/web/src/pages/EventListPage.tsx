import type { ReactNode } from "react";
import type { EventSummary } from "../api/types.js";
import { Link } from "../components/Link.js";
import { ErrorMessage, Loading } from "../components/Status.js";
import { useFetch } from "../hooks/useFetch.js";
import { formatStartsAt } from "../format.js";

export function EventListPage(): ReactNode {
  const { state, retry } = useFetch<EventSummary[]>("/api/events");

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorMessage message={state.message} retry={retry} />;

  return (
    <section>
      <h1>Upcoming events</h1>
      {state.data.length === 0 ? (
        <p className="status">No upcoming events.</p>
      ) : (
        <ul className="cards" data-testid="event-list">
          {state.data.map((event) => (
            <li key={event.id} className="card" data-testid="event-card">
              <Link to={`/events/${event.id}`}>{event.name}</Link>
              <p>
                {event.venue} · {formatStartsAt(event.startsAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
