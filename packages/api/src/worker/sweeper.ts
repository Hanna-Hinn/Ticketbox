import { compose } from "../main/composition.js";
import { config } from "../main/config.js";
import { runEvery } from "./runEvery.js";
import { sweepOnce } from "./sweepOnce.js";

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
  () => sweepOnce(system.sweeper, log),
  (err: unknown) => log.error({ err }, "sweep failed; retrying next tick"),
);
log.info({ intervalMs: SWEEP_INTERVAL_MS }, "sweeper started");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    // A tick in flight finishes against a closing client and logs one
    // "sweep failed" after this line; the next tick never starts.
    stop();
    system.close().catch((err: unknown) => {
      log.error({ err }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}
