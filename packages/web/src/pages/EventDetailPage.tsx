import type { ReactNode } from "react";
import type { EventDetail } from "../api/types.js";
import { Link } from "../components/Link.js";
import { ErrorMessage, Loading } from "../components/Status.js";
import { useFetch } from "../hooks/useFetch.js";
import { formatPrice, formatStartsAt } from "../format.js";

// Every number on this page came from the API. "Sold out" is the label for
// the API's remaining = 0, not a decision made here.
export function EventDetailPage({ id }: { id: string }): ReactNode {
  const { state, retry } = useFetch<EventDetail>(`/api/events/${encodeURIComponent(id)}`);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorMessage message={state.message} retry={retry} />;

  const event = state.data;
  return (
    <section>
      <p>
        <Link to="/">← All events</Link>
      </p>
      <h1>{event.name}</h1>
      <p>
        {event.venue} · {formatStartsAt(event.startsAt)}
      </p>
      <table className="tiers">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Price</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody>
          {event.tiers.map((tier) => (
            <tr key={tier.id} data-testid="tier-row">
              <td>{tier.name}</td>
              <td>{formatPrice(tier.priceCents)}</td>
              <td data-testid="tier-remaining">
                {tier.remaining === 0 ? "Sold out" : `${tier.remaining} of ${tier.total}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
