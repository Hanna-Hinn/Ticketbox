import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";
import type { EventRepository } from "../ports/EventRepository.js";
import type { HoldRepository } from "../ports/HoldRepository.js";
import type { InventoryRepair } from "../ports/InventoryRepair.js";

export interface ReconcileEventInput {
  readonly eventId: EventId;
}

export interface ReconciledTier {
  readonly tierId: TierId;
  /** The live counter before; null when there was none (a flushed or evicted key). */
  readonly before: number | null;
  readonly after: number;
}

export type ReconcileEventOutput =
  | {
      ok: true;
      tiers: readonly ReconciledTier[];
      /** Active rows whose hold is gone from the store — no entry, no hash — now marked expired. */
      rowsExpired: number;
      /** Holds the store still counts and the mirror has no active row for: subtracted from the counter, not recorded. */
      unrecorded: readonly HoldToken[];
    }
  | { ok: false; reason: "unknown-event" };

// The escape hatch for when the two stores disagree (ADR 0006). First the
// mirror is made to agree with what the store still holds, then the
// counter is recomputed from Postgres and overwritten. Recomputed from the
// rows as found, a FLUSHDB would leave every in-flight hold's row active
// forever (nothing sweeps a hold whose index entry is gone) and the
// counter short by their quantity for good. The repository handed in here
// must read Postgres, not a cache: the composition root's job.
export class ReconcileEventUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly store: InventoryRepair,
    private readonly mirror: HoldRepository,
  ) {}

  async execute(input: ReconcileEventInput): Promise<ReconcileEventOutput> {
    const event = await this.events.findById(input.eventId);
    if (event === null) return { ok: false, reason: "unknown-event" };

    let rowsExpired = 0;
    const unrecorded: HoldToken[] = [];
    const unrecordedQty = new Map<TierId, number>();
    for (const tier of event.tiers) {
      const held = await this.store.held(tier.id);
      const heldTokens = new Set(held.map((entry) => entry.token));
      const active = new Set(await this.mirror.activeTokens(tier.id));
      for (const token of active) {
        if (heldTokens.has(token)) continue;
        // No entry is not "no hold": the index key can be evicted on its
        // own, and a reserve plus its save can land between the index read
        // and the row read. A hash that is alive is a hold: its row stays
        // active and the recomputation subtracts it. Its entry is not
        // rebuilt; when the hash dies nothing restores it, and the next
        // call — hash gone, entry gone — expires the row and the counter
        // stops subtracting it. Only a hold gone from both is gone.
        if ((await this.store.find(token)) !== null) continue;
        await this.mirror.setStatus(token, "expired");
        rowsExpired += 1;
      }
      // Held by the store, unknown to the rows (the save failed and the
      // compensating release failed too — ADR 0004 row 1): the rows cannot
      // subtract it, so the counter does, by the entry's own quantity. A
      // later release or sweep adds it back through the scripts; no row is
      // written here — reconcile reads the index, it does not re-record.
      let qty = 0;
      for (const entry of held) {
        if (active.has(entry.token)) continue;
        unrecorded.push(entry.token);
        qty += entry.qty;
      }
      unrecordedQty.set(tier.id, qty);
    }

    // Now the rows say what the store holds; recompute from them.
    const repaired = await this.events.findById(input.eventId);
    // Rows have been written against an event that was there a moment ago.
    if (repaired === null) throw new Error(`event ${input.eventId} vanished during reconcile`);
    const tiers: ReconciledTier[] = [];
    for (const tier of repaired.tiers) {
      // Postgres already clamps at 0 (GREATEST); unrecorded holds can push
      // below it only when history is already wrong (more held than exists).
      // 0 is the honest floor for a counter; the report shows the clamp as
      // after: 0 against a before that was lower.
      const after = Math.max(0, tier.remaining - (unrecordedQty.get(tier.id) ?? 0));
      const { before } = await this.store.rebuild(tier.id, after);
      tiers.push({ tierId: tier.id, before, after });
    }
    return { ok: true, tiers, rowsExpired, unrecorded };
  }
}
