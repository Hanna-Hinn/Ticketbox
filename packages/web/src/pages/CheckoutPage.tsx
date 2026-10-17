import { useState, type ReactNode } from "react";
import type { EventDto } from "@ticketbox/api/src/presentation/dto/events.js";
import type { HoldDto } from "@ticketbox/api/src/presentation/dto/holds.js";
import { api, ApiError } from "../api/client.js";
import { Countdown } from "../components/Countdown.js";
import { Link } from "../components/Link.js";
import { ErrorMessage, Loading } from "../components/Status.js";
import { navigate } from "../hooks/usePath.js";
import { useRequest } from "../hooks/useRequest.js";
import { formatPrice } from "../format.js";

// The hold, then the event it belongs to (a cache hit on the API), rendered
// as an order summary. No total: qty × price is the first arithmetic the
// browser would do about money, and the order (TB-029) will say the total.
export function CheckoutPage({ token }: { token: string }): ReactNode {
  const { state, retry } = useRequest(token, async (signal) => {
    const hold = await api.getHold(token, signal);
    const event = await api.getEvent(hold.eventId, signal);
    return { hold, event };
  });
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | undefined>(undefined);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return state.message.startsWith("404") ? (
      <p className="status" data-testid="hold-gone">
        This hold has expired or was released. <Link to="/">All events</Link>
      </p>
    ) : (
      <ErrorMessage message={state.message} retry={retry} />
    );
  }

  const { hold, event } = state.data;
  const tier = event.tiers.find((candidate) => candidate.id === hold.tierId);

  const release = async (): Promise<void> => {
    setReleasing(true);
    setReleaseError(undefined);
    try {
      await api.releaseHold(hold.token);
      navigate(`/events/${hold.eventId}`);
    } catch (err: unknown) {
      setReleaseError(err instanceof ApiError ? `${err.status} ${err.message}` : String(err));
      setReleasing(false);
    }
  };

  return (
    <section>
      <h1>Your tickets are held</h1>
      <Countdown expiresAt={hold.expiresAt} onZero={retry} />
      <Summary
        event={event}
        tierName={tier?.name ?? hold.tierId}
        hold={hold}
        tierPriceCents={tier?.priceCents}
      />
      <p>
        <button
          type="button"
          onClick={() => void release()}
          disabled={releasing}
          data-testid="release"
        >
          Release
        </button>{" "}
        <Link to={`/events/${hold.eventId}`}>Back to the event</Link>
      </p>
      {releaseError !== undefined && (
        <p className="status error" role="alert">
          Could not release: {releaseError}
        </p>
      )}
    </section>
  );
}

function Summary({
  event,
  tierName,
  tierPriceCents,
  hold,
}: {
  event: EventDto;
  tierName: string;
  tierPriceCents: number | undefined;
  hold: HoldDto;
}): ReactNode {
  return (
    <dl className="summary" data-testid="summary">
      <dt>Event</dt>
      <dd>{event.name}</dd>
      <dt>Tier</dt>
      <dd>{tierName}</dd>
      <dt>Tickets</dt>
      <dd data-testid="summary-qty">
        {hold.qty}
        {tierPriceCents === undefined ? "" : ` × ${formatPrice(tierPriceCents)}`}
      </dd>
    </dl>
  );
}
