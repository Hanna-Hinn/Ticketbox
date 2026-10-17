import type { HoldStore } from "../../application/ports/HoldStore.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// The HoldStore until TB-022 builds the real one. It has never seen any
// tier, so every read falls back to the computed count (ADR 0002), and it
// refuses to reserve or release rather than pretend. Deleted by TB-022.
export class UnconfiguredHoldStore implements HoldStore {
  async reserve(): Promise<
    { ok: true; remaining: number } | { ok: false; reason: "insufficient" }
  > {
    throw new Error("HoldStore is not configured until TB-022");
  }

  async release(): Promise<
    { released: true; tierId: TierId; remaining: number } | { released: false }
  > {
    throw new Error("HoldStore is not configured until TB-022");
  }

  async availability(): Promise<ReadonlyMap<TierId, number>> {
    return new Map();
  }
}
