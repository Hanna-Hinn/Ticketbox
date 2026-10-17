import { z } from "zod";

export const ReconcileParams = z.object({ eventId: z.uuid() });

// The report: what each counter was and is now (drift is the reader's
// subtraction), and what the mirror had wrong on either side.
export const ReconcileResponse = z.object({
  eventId: z.uuid(),
  tiers: z.array(
    z.object({
      tierId: z.uuid(),
      before: z.int().nullable(),
      after: z.int().nonnegative(),
    }),
  ),
  rowsExpired: z.int().nonnegative(),
  rowsRecorded: z.int().nonnegative(),
  unrecorded: z.array(z.string()),
});

export type ReconcileDto = z.infer<typeof ReconcileResponse>;
