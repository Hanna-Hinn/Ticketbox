import type { Hold } from "../../domain/entities/Hold.js";
import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

// The Postgres mirror of a hold (TB-024): the audit trail, never the live
// truth. The live hold in Redis has no status — it exists or it doesn't —
// which is why the lifecycle lives here and not on the Hold entity.
export type HoldStatus = "active" | "converted" | "expired" | "released";

// A row is born "active" via save() and ends in exactly one of the others.
// Going back to "active" is not a transition the audit trail allows.
export type HoldOutcome = Exclude<HoldStatus, "active">;

export interface HoldRepository {
  /** Writes the row with status "active". */
  save(hold: Hold): Promise<void>;
  setStatus(token: HoldToken, status: HoldOutcome): Promise<void>;
  /**
   * Tokens of the rows still 'active' for the tier — the mirror's one read
   * path, for reconciliation (TB-027), never for a write-path decision.
   */
  activeTokens(tierId: TierId): Promise<readonly HoldToken[]>;
}
