import { z } from "zod";

// Tokens are crypto.randomUUID() (UuidTokenGenerator); a malformed one is a
// 400 from the schema, never a store round trip.
export const HoldTokenParams = z.object({ token: z.uuid() });

// The upper bound on qty is the entity's (Quantity.MAX_PER_HOLD), surfaced as
// InvalidQuantity: one copy of the rule, not a second one here.
export const CreateHoldRequest = z.object({
  eventId: z.uuid(),
  tierId: z.uuid(),
  qty: z.int().min(1),
});

export const CreatedHoldResponse = z.object({
  token: z.string(),
  eventId: z.string(),
  tierId: z.string(),
  qty: z.int().positive(),
  expiresAt: z.iso.datetime(),
  remaining: z.int().nonnegative(),
});

export const HoldResponse = z.object({
  token: z.string(),
  eventId: z.string(),
  tierId: z.string(),
  qty: z.int().positive(),
  expiresAt: z.iso.datetime(),
  // What the countdown starts from; the server is the authority on time.
  remainingMs: z.int().nonnegative(),
});

// Idempotent: a token that is gone, expired, or was never issued is
// `released: false`, 200, not 404 — the second call of a retry must not
// look like a failure.
export const ReleaseResponse = z.object({ released: z.boolean() });

export type CreateHoldDto = z.infer<typeof CreateHoldRequest>;
export type CreatedHoldDto = z.infer<typeof CreatedHoldResponse>;
export type HoldDto = z.infer<typeof HoldResponse>;
export type ReleaseDto = z.infer<typeof ReleaseResponse>;
