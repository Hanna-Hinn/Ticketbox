import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
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
