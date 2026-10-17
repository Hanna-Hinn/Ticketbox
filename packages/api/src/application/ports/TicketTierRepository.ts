import type { TicketTier } from "../../domain/entities/TicketTier.js";
import type { TierId } from "../../domain/value-objects/Ids.js";

export interface TicketTierRepository {
  findById(id: TierId): Promise<TicketTier | null>;
}
