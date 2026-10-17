import { compose } from "../main/composition.js";
import { config } from "../main/config.js";
import { runEvery } from "./runEvery.js";

// The expired-hold sweeper (TB-026): the same composition root as the API,
// never listening, ticking the sweep every 5 s. Five seconds is the delivery
// plan's number; the hold's TTL is two minutes, so an abandoned cart's
// tickets are back within 125 s of the click, and the countdown the
// browser shows (TB-025) is never longer than the truth.
const SWEEP_INTERVAL_MS = 5_000;

const system = compose(config);
const log = system.app.log.child({ component: "sweeper" });

const stop = runEvery(
  SWEEP_INTERVAL_MS,
  async () => {
    const result = await system.sweeper.execute();
    if (result.swept > 0) log.info(result, "swept expired holds");
    if (result.unmarked.length > 0) {
      // Tickets are back; the rows still say active. Reconciliation (TB-027)
      // closes that; until then the tokens are in the log.
      log.error({ tokens: result.unmarked }, "expired holds swept but their rows not marked");
    }
  },
  (err: unknown) => log.error({ err }, "sweep failed; retrying next tick"),
);
log.info({ intervalMs: SWEEP_INTERVAL_MS }, "sweeper started");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    stop();
    system.close().catch((err: unknown) => {
      log.error({ err }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}
