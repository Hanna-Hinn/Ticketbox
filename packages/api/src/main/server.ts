import { compose } from "./composition.js";
import { config } from "./config.js";

const system = compose(config);

// Memoised: a supervisor's SIGINT-then-SIGTERM must not end the pool twice,
// and a failed close is a logged line, never an unhandled rejection.
let closing: Promise<void> | undefined;
function shutdown(signal: NodeJS.Signals): Promise<void> {
  closing ??= (async () => {
    system.app.log.info({ signal }, "shutting down");
    await system.close();
  })();
  return closing;
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      system.app.log.error({ err }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}

// 0.0.0.0, not localhost: the API must be reachable from outside its own
// container once the compose stage arrives.
await system.app.listen({ port: config.PORT, host: "0.0.0.0" });
