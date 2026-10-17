import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // How long a hold lives (handbook: 120 s). Settable so a test can use a
  // short real TTL (TB-028a).
  HOLD_TTL_MS: z.coerce.number().int().min(1).default(120_000),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      `Invalid configuration:\n${lines.join("\n")}\n\nCheck your .env against .env.example.`,
    );
  }

  return Object.freeze(result.data);
}

export const config: Config = loadConfig(process.env);
