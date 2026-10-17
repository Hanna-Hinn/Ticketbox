import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { EventId, TierId } from "../../domain/value-objects/Ids.js";
import type { EventRepository } from "../ports/EventRepository.js";
import type { HoldRepository } from "../ports/HoldRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";

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
      /** Active rows whose hold is gone from the store, now marked expired. */
      rowsExpired: number;
      /** Holds the store still had and the mirror did not, now recorded. */
      rowsRecorded: number;
      /** Held entries with neither a row nor a hash: counted as held, not recordable. */
      unrecorded: readonly HoldToken[];
    }
  | { ok: false; reason: "unknown-event" };

// The escape hatch for when the two stores disagree (ADR 0006). The mirror
// is made to agree with what the store still holds — rows for holds that
// are gone become expired, holds with no row get their row — and only then
// is the counter recomputed from Postgres and overwritten. Recomputed from
// the rows as found, a FLUSHDB would leave every in-flight hold's row
// active forever (nothing sweeps a hold whose index entry is gone) and
// the counter short by their quantity for good; a hold with no row would
// be restored on top of the rebuild. The repository handed in here must
// read Postgres, not a cache: the composition root's job.
export class ReconcileEventUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly holds: HoldStore,
    private readonly mirror: HoldRepository,
  ) {}

  async execute(input: ReconcileEventInput): Promise<ReconcileEventOutput> {
    const event = await this.events.findById(input.eventId);
    if (event === null) return { ok: false, reason: "unknown-event" };

    let rowsExpired = 0;
    let rowsRecorded = 0;
    const unrecorded: HoldToken[] = [];
    // Per tier: what the store still holds against what the rows say.
    const uncounted = new Map<TierId, number>();
    for (const tier of event.tiers) {
      const held = await this.holds.held(tier.id);
      const heldTokens = new Set(held.map((entry) => entry.token));
      const active = new Set(await this.mirror.activeTokens(tier.id));
      for (const token of active) {
        if (heldTokens.has(token)) continue;
        await this.mirror.setStatus(token, "expired");
        rowsExpired += 1;
      }
      let notRecordable = 0;
      for (const entry of held) {
        if (active.has(entry.token)) continue;
        const hold = await this.holds.find(entry.token);
        if (hold === null) {
          // The entry survived, the hash did not: the sweeper will restore
          // its quantity, so the counter must keep counting it as held, but
          // a row needs the instants only the hash had.
          unrecorded.push(entry.token);
          notRecordable += entry.qty;
          continue;
        }
        await this.mirror.save(hold);
        rowsRecorded += 1;
      }
      uncounted.set(tier.id, notRecordable);
    }

    // Now the rows say what the store holds; recompute from them.
    const repaired = await this.events.findById(input.eventId);
    if (repaired === null) return { ok: false, reason: "unknown-event" };
    const tiers: ReconciledTier[] = [];
    for (const tier of repaired.tiers) {
      const after = Math.max(0, tier.remaining - (uncounted.get(tier.id) ?? 0));
      const { before } = await this.holds.rebuild(tier.id, after);
      tiers.push({ tierId: tier.id, before, after });
    }
    return { ok: true, tiers, rowsExpired, rowsRecorded, unrecorded };
  }
}
