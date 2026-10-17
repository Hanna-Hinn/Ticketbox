import type { ReleaseExpiredHoldsOutput } from "../application/use-cases/ReleaseExpiredHolds.js";

// The two calls the tick makes; pino's and Fastify's loggers both fit.
export interface SweepLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

// One tick of the sweeper, as the worker logs it: the counts at info when
// anything was swept, and one error line per row that could not be marked,
// carrying the reason — tickets are back, the row still says active, and
// reconciliation (TB-027) closes that; until then the token and the error
// are in the log.
export async function sweepOnce(
  sweeper: { execute(): Promise<ReleaseExpiredHoldsOutput> },
  log: SweepLog,
): Promise<void> {
  const result = await sweeper.execute();
  if (result.swept > 0) {
    log.info(
      { swept: result.swept, restored: result.restored, unmarked: result.unmarked.length },
      "swept expired holds",
    );
  }
  for (const { token, error } of result.unmarked) {
    log.error({ token, err: error }, "expired hold swept but its row not marked");
  }
}
