import type { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// What reconciliation (TB-027) needs from the store, and nothing the write
// path needs: a port of its own so HoldStore does not grow a method per
// consumer. The same adapter implements both.
export interface HeldEntry {
  readonly token: HoldToken;
  readonly qty: number;
}

export interface InventoryRepair {
  /** Every hold the store's index still counts as held for the tier, expired-but-unswept included. */
  held(tierId: TierId): Promise<readonly HeldEntry[]>;

  /** The live hold, or null once it has expired, was evicted, or never existed. */
  find(token: HoldToken): Promise<Hold | null>;

  /** Overwrite the live counter; answers the value it replaced, null if there was none. */
  rebuild(tierId: TierId, remaining: number): Promise<{ before: number | null }>;
}
