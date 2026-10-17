import { InvalidHold } from "../errors/InvalidHold.js";
import type { HoldToken } from "../value-objects/HoldToken.js";
import type { EventId, TierId } from "../value-objects/Ids.js";
import type { Quantity } from "../value-objects/Quantity.js";

export interface CreateHoldProps {
  readonly token: HoldToken;
  readonly eventId: EventId;
  readonly tierId: TierId;
  readonly qty: Quantity;
  readonly now: Date;
  readonly ttlMs: number;
}

// A temporary reservation. The core concept of the product: it is alive for
// exactly ttlMs from its creation instant, and the entity, not the caller,
// decides what "expired" means.
//
// Instants are stored as epoch milliseconds, not Date objects: a Date is
// mutable, and `readonly expiresAt: Date` would still let a caller rewrite
// the expiry with setTime(). The getters mint a fresh Date each call.
export class Hold {
  private constructor(
    readonly token: HoldToken,
    // The event the tier belongs to: the checkout page is reached by token
    // alone and must find its way back to the event (TB-025).
    readonly eventId: EventId,
    readonly tierId: TierId,
    readonly qty: Quantity,
    private readonly createdAtMs: number,
    private readonly expiresAtMs: number,
  ) {}

  static create(props: CreateHoldProps): Hold {
    if (!Number.isSafeInteger(props.ttlMs) || props.ttlMs <= 0) {
      throw new InvalidHold(`ttlMs must be a positive safe integer, got ${props.ttlMs}`);
    }
    const createdAtMs = instant(props.now);
    const expiresAtMs = createdAtMs + props.ttlMs;
    // Past the Date range the sum is representable as a number but not as a
    // Date, and a hold whose expiry is NaN would never expire.
    if (Number.isNaN(new Date(expiresAtMs).getTime())) {
      throw new InvalidHold(`expiry ${expiresAtMs} is outside the representable date range`);
    }
    return new Hold(props.token, props.eventId, props.tierId, props.qty, createdAtMs, expiresAtMs);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get expiresAt(): Date {
    return new Date(this.expiresAtMs);
  }

  // Expired *at* the boundary instant, not one ms after: Redis deletes the key
  // at (or after) the TTL elapsing, so "alive at exactly expiresAt" would be a
  // claim the store could already disagree with.
  isExpired(now: Date): boolean {
    return instant(now) >= this.expiresAtMs;
  }

  remainingMs(now: Date): number {
    return Math.max(0, this.expiresAtMs - instant(now));
  }
}

// An invalid Date compares false against everything, which would read as
// "not expired" forever. A clock that cannot tell the time is a bug.
function instant(date: Date): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new InvalidHold("not a valid date");
  return ms;
}
