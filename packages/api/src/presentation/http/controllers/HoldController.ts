import type { CreateHoldUseCase } from "../../../application/use-cases/CreateHold.js";
import type { GetHoldUseCase } from "../../../application/use-cases/GetHold.js";
import type { ReleaseHoldUseCase } from "../../../application/use-cases/ReleaseHold.js";
import { EventNotFound } from "../../../domain/errors/EventNotFound.js";
import { HoldNotFound } from "../../../domain/errors/HoldNotFound.js";
import { InsufficientInventory } from "../../../domain/errors/InsufficientInventory.js";
import { TierNotFound } from "../../../domain/errors/TierNotFound.js";
import { holdToken } from "../../../domain/value-objects/HoldToken.js";
import { eventId, tierId } from "../../../domain/value-objects/Ids.js";
import type { CreatedHoldDto, CreateHoldDto, HoldDto, ReleaseDto } from "../../dto/holds.js";

// Map in, call one use case, map out. A use case's "no" becomes the typed
// error the single handler turns into a status; no status lives here.
export class HoldController {
  constructor(
    private readonly createHold: CreateHoldUseCase,
    private readonly getHold: GetHoldUseCase,
    private readonly releaseHold: ReleaseHoldUseCase,
  ) {}

  async create(body: CreateHoldDto): Promise<CreatedHoldDto> {
    const result = await this.createHold.execute({
      eventId: eventId(body.eventId),
      tierId: tierId(body.tierId),
      qty: body.qty,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "unknown-event":
          throw new EventNotFound(body.eventId);
        case "unknown-tier":
          throw new TierNotFound(body.tierId);
        case "insufficient":
          throw new InsufficientInventory(body.tierId);
      }
    }
    return {
      token: result.token,
      eventId: result.eventId,
      tierId: result.tierId,
      qty: result.qty,
      expiresAt: result.expiresAt.toISOString(),
      remaining: result.remaining,
    };
  }

  async get(token: string): Promise<HoldDto> {
    const result = await this.getHold.execute({ token: holdToken(token) });
    if (!result.ok) throw new HoldNotFound(token);
    return {
      token: result.token,
      eventId: result.eventId,
      tierId: result.tierId,
      qty: result.qty,
      expiresAt: result.expiresAt.toISOString(),
      remainingMs: result.remainingMs,
    };
  }

  async release(token: string): Promise<ReleaseDto> {
    const result = await this.releaseHold.execute({ token: holdToken(token) });
    return { released: result.released };
  }
}
