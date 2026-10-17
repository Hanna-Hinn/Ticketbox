import { InvalidHold } from "../errors/InvalidHold.js";
import type { HoldToken } from "../value-objects/HoldToken.js";
import type { TierId } from "../value-objects/Ids.js";
import type { Quantity } from "../value-objects/Quantity.js";

export interface CreateHoldProps {
  readonly token: HoldToken;
  readonly tierId: TierId;
  readonly qty: Quantity;
  readonly now: Date;
  readonly ttlMs: number;
}

// A temporary reservation. The core concept of the product: it is alive for
// exactly ttlMs from its creation instant, and the entity, not the caller,
// decides what "expired" means.
export class Hold {
  private constructor(
    readonly token: HoldToken,
    readonly tierId: TierId,
    readonly qty: Quantity,
    readonly createdAt: Date,
    readonly expiresAt: Date,
  ) {}

  static create(props: CreateHoldProps): Hold {
    if (!Number.isInteger(props.ttlMs) || props.ttlMs <= 0) {
      throw new InvalidHold(`ttlMs must be a positive integer, got ${props.ttlMs}`);
    }
    const createdAt = new Date(props.now.getTime());
    const expiresAt = new Date(createdAt.getTime() + props.ttlMs);
    return new Hold(props.token, props.tierId, props.qty, createdAt, expiresAt);
  }

  // Expired *at* the boundary instant, not one ms after: Redis deletes the key
  // at (or after) the TTL elapsing, so "alive at exactly expiresAt" would be a
  // claim the store could already disagree with.
  isExpired(now: Date): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  remainingMs(now: Date): number {
    return Math.max(0, this.expiresAt.getTime() - now.getTime());
  }
}
