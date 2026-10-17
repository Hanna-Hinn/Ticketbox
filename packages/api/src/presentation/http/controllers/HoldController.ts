import type { ReleaseHoldUseCase } from "../../../application/use-cases/ReleaseHold.js";
import { holdToken } from "../../../domain/value-objects/HoldToken.js";
import type { ReleaseDto } from "../../dto/holds.js";

// Map in, call one use case, map out. POST /holds and GET /holds/:token
// arrive with the UI that needs them (TB-025).
export class HoldController {
  constructor(private readonly releaseHold: ReleaseHoldUseCase) {}

  async release(token: string): Promise<ReleaseDto> {
    const result = await this.releaseHold.execute({ token: holdToken(token) });
    return { released: result.released };
  }
}
