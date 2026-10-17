import { useRef, useState, type ReactNode } from "react";
import type { HoldDto } from "@ticketbox/api/src/presentation/dto/holds.js";
import type { OrderDto } from "@ticketbox/api/src/presentation/dto/orders.js";
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
//
// Confirm (TB-030) sends the email with one idempotency key, minted when the
// page mounts and never changed: a double-click, a retry after a timeout, a
// second submit — all the same request to the server, and one order. A new
// key is a new page.
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
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);
  const [order, setOrder] = useState<OrderDto | undefined>(undefined);
  // A double-click sends two requests under the one key; the server answers
  // the second 409 before the first has finished. Not an error to show:
  // while a sibling is still out, its answer is the page's.
  const inFlight = useRef(0);

  // The order outlives the hold it consumed: once confirmed, the hold is
  // gone from the server, and this page shows the order, not the gap.
  if (order !== undefined) {
    return (
      <section data-testid="confirmed">
        <h1>Order confirmed</h1>
        <p data-testid="order-id">Order {order.orderId}</p>
        <p data-testid="order-total">Total {formatPrice(order.totalCents)}</p>
        <p>A confirmation goes to {order.email}.</p>
        <p>
          <Link to="/">All events</Link>
        </p>
      </section>
    );
  }

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

  const confirm = async (): Promise<void> => {
    inFlight.current += 1;
    setConfirming(true);
    setConfirmError(undefined);
    try {
      setOrder(await api.createOrder({ holdToken: hold.token, email }, idempotencyKey));
    } catch (err: unknown) {
      // 410: the hold went while the form was open; the re-fetch shows that.
      if (err instanceof ApiError && err.status === 410) {
        retry();
        return;
      }
      if (inFlight.current > 1) return;
      setConfirmError(err instanceof ApiError ? `${err.status} ${err.message}` : String(err));
      setConfirming(false);
    } finally {
      inFlight.current -= 1;
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
      <form
        className="confirm-form"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <label>
          Email{" "}
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={confirming}
            data-testid="email"
          />
        </label>{" "}
        <button type="submit" disabled={confirming} data-testid="confirm">
          Confirm
        </button>
      </form>
      {confirmError !== undefined && (
        <p className="status error" role="alert" data-testid="confirm-error">
          Could not confirm: {confirmError}
        </p>
      )}
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
