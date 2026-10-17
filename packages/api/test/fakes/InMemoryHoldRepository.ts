import type {
  HoldOutcome,
  HoldRepository,
  HoldStatus,
} from "../../src/application/ports/HoldRepository.js";
import type { Hold } from "../../src/domain/entities/Hold.js";
import type { HoldToken } from "../../src/domain/value-objects/HoldToken.js";

// The audit trail on a Map, with the two rules the real table enforces: a
// token is saved once (the primary key), and a row only ever leaves
// 'active' (the first outcome is kept).
export class InMemoryHoldRepository implements HoldRepository {
  private readonly rows = new Map<HoldToken, { hold: Hold; status: HoldStatus }>();

  async save(hold: Hold): Promise<void> {
    if (this.rows.has(hold.token)) throw new Error(`hold ${hold.token} already mirrored`);
    this.rows.set(hold.token, { hold, status: "active" });
  }

  async setStatus(token: HoldToken, status: HoldOutcome): Promise<void> {
    const row = this.rows.get(token);
    if (row === undefined || row.status !== "active") return;
    row.status = status;
  }

  statusOf(token: HoldToken): HoldStatus | undefined {
    return this.rows.get(token)?.status;
  }

  saved(token: HoldToken): Hold | undefined {
    return this.rows.get(token)?.hold;
  }

  get size(): number {
    return this.rows.size;
  }
}
