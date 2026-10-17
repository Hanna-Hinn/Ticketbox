import { z } from "zod";

export const ReconcileParams = z.object({ eventId: z.uuid() });

// The report: what each counter was and is now (drift is the reader's
// subtraction), the rows of holds that were gone, and the holds the rows
// never knew about (counted, not recorded).
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
  unrecorded: z.array(z.string()),
});

export type ReconcileDto = z.infer<typeof ReconcileResponse>;
