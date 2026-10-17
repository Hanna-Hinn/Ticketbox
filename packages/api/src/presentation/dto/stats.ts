import { z } from "zod";

export const StatsResponse = z.object({
  cache: z.object({
    hits: z.int().nonnegative(),
    misses: z.int().nonnegative(),
    hitRatio: z.number().min(0).max(1),
  }),
});

export type StatsDto = z.infer<typeof StatsResponse>;
