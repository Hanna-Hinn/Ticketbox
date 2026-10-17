import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { Clock } from "../ports/Clock.js";
import type { HoldRepository } from "../ports/HoldRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";

export interface ReleaseExpiredHoldsOutput {
  /** Entries this run removed from the index. */
  readonly swept: number;
  /** Of those, the ones whose tickets went back (the rest had no counter). */
  readonly restored: number;
  /** Swept holds whose row could not be marked, and why: active rows for holds that are gone (ADR 0004 row 2). */
  readonly unmarked: readonly { readonly token: HoldToken; readonly error: unknown }[];
}

// The sweeper's one pass: every hold the index says has expired, restored
// through the store's once-only sweep, then its row marked — after the
// restore, never instead of it. A row that cannot be marked is reported,
// not thrown: this is a batch, and a Postgres outage must not throttle
// inventory restoration to one hold per tick. A store error does abort
// the pass — Redis is the engine being worked, and the next tick retries.
export class ReleaseExpiredHoldsUseCase {
  constructor(
    private readonly holds: HoldStore,
    private readonly mirror: HoldRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ReleaseExpiredHoldsOutput> {
    // One reading for the whole pass: the store's "expired" and the script's
    // own guard answer the same question about the same instant.
    const now = this.clock.now();
    const expired = await this.holds.expired(now);
    let swept = 0;
    let restored = 0;
    const unmarked: { token: HoldToken; error: unknown }[] = [];
    for (const hold of expired) {
      const result = await this.holds.sweep(hold, now);
      if (!result.swept) continue;
      swept += 1;
      if (result.restored) restored += 1;
      try {
        await this.mirror.setStatus(hold.token, "expired");
      } catch (error: unknown) {
        unmarked.push({ token: hold.token, error });
      }
    }
    return { swept, restored, unmarked };
  }
}
