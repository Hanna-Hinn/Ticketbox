import { useState, type FormEvent, type ReactNode } from "react";
import type { EventDto } from "@ticketbox/api/src/presentation/dto/events.js";
import { api, ApiError } from "../api/client.js";
import { navigate } from "../hooks/usePath.js";
import { Link } from "../components/Link.js";
import { ErrorMessage, Loading } from "../components/Status.js";
import { useRequest } from "../hooks/useRequest.js";
import { formatPrice, formatStartsAt } from "../format.js";

// Every number on this page came from the API. "Sold out" is the label for
// the API's remaining = 0, not a decision made here.

// A quantity and a button. No bound and no "sold out" decision here: a tier
// the page saw at 0 may have a ticket back by the time the button is
// pressed, and the API's own answer — 409, 400 — is shown verbatim.
type TierDto = EventDto["tiers"][number];

function HoldForm({ eventId, tier }: { eventId: string; tier: TierDto }): ReactNode {
  const [qty, setQty] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const hold = await api.createHold({ eventId, tierId: tier.id, qty });
      navigate(`/checkout/${hold.token}`);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <form className="hold-form" onSubmit={(event) => void submit(event)}>
      <input
        type="number"
        min="1"
        step="1"
        required
        value={qty}
        onChange={(event) => setQty(Number(event.target.value))}
        aria-label={`Tickets for ${tier.name}`}
        data-testid="qty"
        disabled={pending}
      />
      <button type="submit" disabled={pending} data-testid="get-tickets">
        Get tickets
      </button>
      {error !== undefined && (
        <span className="error" role="alert" data-testid="hold-error">
          {error}
        </span>
      )}
    </form>
  );
}
export function EventDetailPage({ id }: { id: string }): ReactNode {
  const { state, retry } = useRequest(id, (signal) => api.getEvent(id, signal));

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
            <th></th>
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
              <td>
                <HoldForm eventId={event.id} tier={tier} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
