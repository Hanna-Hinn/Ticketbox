import type { ReconcileEventUseCase } from "../../../application/use-cases/ReconcileEvent.js";
import { EventNotFound } from "../../../domain/errors/EventNotFound.js";
import { eventId } from "../../../domain/value-objects/Ids.js";
import type { ReconcileDto } from "../../dto/admin.js";

export class AdminController {
  constructor(private readonly reconcile: ReconcileEventUseCase) {}

  async reconcileEvent(id: string): Promise<ReconcileDto> {
    const result = await this.reconcile.execute({ eventId: eventId(id) });
    if (!result.ok) throw new EventNotFound(id);
    return {
      eventId: id,
      tiers: result.tiers.map((tier) => ({
        tierId: tier.tierId,
        before: tier.before,
        after: tier.after,
      })),
      rowsExpired: result.rowsExpired,
      unrecorded: [...result.unrecorded],
    };
  }
}
