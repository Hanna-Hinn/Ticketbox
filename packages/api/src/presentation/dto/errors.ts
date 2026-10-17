import { z } from "zod";

// The one error envelope every non-2xx this API writes itself uses. TB-012's
// single error handler owns it from then on.
export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
