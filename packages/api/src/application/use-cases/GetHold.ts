import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";
import type { Clock } from "../ports/Clock.js";
import type { HoldStore } from "../ports/HoldStore.js";

export interface GetHoldInput {
  readonly token: HoldToken;
}

export type GetHoldOutput =
  | {
      ok: true;
      token: HoldToken;
      eventId: EventId;
      tierId: TierId;
      qty: number;
      expiresAt: Date;
      remainingMs: number;
    }
  | { ok: false; reason: "not-found" };

// What the checkout page counts down from. The store already answers null
// past the TTL; asking the entity as well is the server, not the adapter,
// being the authority on time.
export class GetHoldUseCase {
  constructor(
    private readonly holds: HoldStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: GetHoldInput): Promise<GetHoldOutput> {
    const hold = await this.holds.find(input.token);
    // Read the clock after the lookup, never before: the remaining time the
    // client is told must be no more than what is really left.
    const now = this.clock.now();
    if (hold === null || hold.isExpired(now)) return { ok: false, reason: "not-found" };

    return {
      ok: true,
      token: hold.token,
      eventId: hold.eventId,
      tierId: hold.tierId,
      qty: hold.qty.value,
      expiresAt: hold.expiresAt,
      remainingMs: hold.remainingMs(now),
    };
  }
}
