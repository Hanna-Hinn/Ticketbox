import { compose } from "./composition.js";
import { config } from "./config.js";

const system = compose(config);

// system.close() is idempotent, so SIGINT-then-SIGTERM is safe; a failed
// close is a logged line, never an unhandled rejection.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    system.app.log.info({ signal }, "shutting down");
    system.close().catch((err: unknown) => {
      system.app.log.error({ err }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}

// 0.0.0.0, not localhost: the API must be reachable from outside its own
// container once the compose stage arrives.
await system.app.listen({ port: config.PORT, host: "0.0.0.0" });
