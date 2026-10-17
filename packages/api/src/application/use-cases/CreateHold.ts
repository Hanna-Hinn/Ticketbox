import { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";
import { Quantity } from "../../domain/value-objects/Quantity.js";
import type { Clock } from "../ports/Clock.js";
import type { EventRepository } from "../ports/EventRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";
import type { TokenGenerator } from "../ports/TokenGenerator.js";

export interface CreateHoldInput {
  readonly eventId: EventId;
  readonly tierId: TierId;
  readonly qty: number;
}

export type CreateHoldOutput =
  | { ok: true; token: HoldToken; expiresAt: Date; remaining: number }
  | { ok: false; reason: "unknown-event" | "unknown-tier" | "insufficient" };

// The sequence, and nothing about how any step is done: this class never
// learns that reserve is a Lua script or that the event came from SQL.
export class CreateHoldUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly holds: HoldStore,
    private readonly clock: Clock,
    private readonly tokens: TokenGenerator,
    private readonly holdTtlMs: number,
  ) {}

  async execute(input: CreateHoldInput): Promise<CreateHoldOutput> {
    const qty = Quantity.of(input.qty);

    const event = await this.events.findById(input.eventId);
    if (event === null) return { ok: false, reason: "unknown-event" };
    const tier = event.tiers.find((candidate) => candidate.id === input.tierId);
    if (tier === undefined) return { ok: false, reason: "unknown-tier" };

    const token = this.tokens.next();
    // Read the clock before reserving, never after: the expiry the client is
    // told must be no later than the store's real one, or the UI counts down
    // past a key the store has already dropped.
    const now = this.clock.now();
    // Build the entity before touching the store: Hold.create is where ttlMs
    // and the clock reading are validated, and a reserve followed by a throw
    // is inventory nobody can release.
    const hold = Hold.create({ token, tierId: tier.id, qty, now, ttlMs: this.holdTtlMs });

    // The only place the decision is made. No pre-check against
    // tier.remaining: that is a snapshot, and two answers to one question
    // is how a stale one ends up winning.
    const reserved = await this.holds.reserve(hold);
    if (!reserved.ok) return { ok: false, reason: "insufficient" };

    return { ok: true, token, expiresAt: hold.expiresAt, remaining: reserved.remaining };
  }
}
