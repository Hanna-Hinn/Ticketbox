import type { HoldToken } from "../../domain/value-objects/HoldToken.js";
import type { TierId } from "../../domain/value-objects/Ids.js";
import type { HoldRepository } from "../ports/HoldRepository.js";
import type { HoldStore } from "../ports/HoldStore.js";

export interface ReleaseHoldInput {
  readonly token: HoldToken;
}

export type ReleaseHoldOutput =
  { released: true; tierId: TierId; remaining: number } | { released: false };

// One store call, no lookup first: a find followed by a release is two commands
// with a gap between them, and the gap is where a second release, or the
// TTL, slips in. The store's compare-and-restore makes the decision once;
// its `released: false` is the second call, the unknown token and the
// expired hold alike — which is what makes release safe to repeat.
export class ReleaseHoldUseCase {
  constructor(
    private readonly holds: HoldStore,
    private readonly mirror: HoldRepository,
  ) {}

  async execute(input: ReleaseHoldInput): Promise<ReleaseHoldOutput> {
    const result = await this.holds.release(input.token);
    // Only a release the store actually made is recorded: the row says what
    // Redis decided, after it decided it (ADR 0004).
    if (result.released) await this.mirror.setStatus(input.token, "released");
    return result;
  }
}
