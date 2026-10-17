import { z } from "zod";

// The one error envelope every non-2xx this API writes itself uses; the
// single error handler in http/errors.ts is the only writer.
export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export type ErrorDto = z.infer<typeof ErrorResponse>;
