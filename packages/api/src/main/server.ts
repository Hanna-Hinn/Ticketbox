import { compose } from "./composition.js";
import { config } from "./config.js";

const system = compose(config);

async function shutdown(signal: string): Promise<void> {
  system.app.log.info({ signal }, "shutting down");
  await system.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await system.app.listen({ port: config.PORT, host: "0.0.0.0" });
