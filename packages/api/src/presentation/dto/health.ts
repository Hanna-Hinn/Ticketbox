import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(z.string(), z.enum(["ok", "down"])),
});

export type HealthDto = z.infer<typeof HealthResponse>;
