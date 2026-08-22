import { defineConfig } from "vitest/config";

// No setupFiles yet — the Redis FLUSHDB / Postgres-transaction-rollback setup
// (docs/01-tech-lead-architecture-and-standards.md §4.1) arrives with the
// first real integration test (TB-010 / TB-017). A config pointing at a
// setup file that doesn't exist yet is worse than no setup file.
export default defineConfig({
  test: {
    name: "integration",
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
