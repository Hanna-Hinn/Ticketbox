import { z } from "zod";

// Tokens are crypto.randomUUID() (UuidTokenGenerator, TB-025); a malformed
// one is a 400 from the schema, never a store round trip.
export const HoldTokenParams = z.object({ token: z.uuid() });

// Idempotent: a token that is gone, expired, or was never issued is
// `released: false`, 200, not 404 — the second call of a retry must not
// look like a failure.
export const ReleaseResponse = z.object({ released: z.boolean() });

export type ReleaseDto = z.infer<typeof ReleaseResponse>;
