import { useState, type ReactNode } from "react";
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
// A hold that is gone is an expected answer, carried as data (null), not
// as an error message to parse.
export function CheckoutPage({ token }: { token: string }): ReactNode {
  const { state, retry } = useRequest(token, async (signal) => {
    let hold: HoldDto;
    try {
      hold = await api.getHold(token, signal);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
    const event = await api.getEvent(hold.eventId, signal);
    return { hold, event };
  });
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | undefined>(undefined);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorMessage message={state.message} retry={retry} />;
  if (state.data === null) {
    return (
      <p className="status" data-testid="hold-gone">
        This hold has expired or was released. <Link to="/">All events</Link>
      </p>
    );
  }

  const { hold, event } = state.data;
  // The hold was created against this tier; the event always carries it.
  const tier = event.tiers.find((candidate) => candidate.id === hold.tierId);
  if (tier === undefined) {
    return <ErrorMessage message={`tier ${hold.tierId} is not on its event`} retry={retry} />;
  }

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
      <Countdown key={hold.remainingMs} remainingMs={hold.remainingMs} onZero={retry} />
      <dl className="summary" data-testid="summary">
        <dt>Event</dt>
        <dd>{event.name}</dd>
        <dt>Tier</dt>
        <dd>{tier.name}</dd>
        <dt>Tickets</dt>
        <dd data-testid="summary-qty">
          {hold.qty} × {formatPrice(tier.priceCents)}
        </dd>
      </dl>
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
        <p className="status error" role="alert" data-testid="release-error">
          Could not release: {releaseError}
        </p>
      )}
    </section>
  );
}
