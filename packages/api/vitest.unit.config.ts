import { defineConfig } from "vitest/config";

// Coverage thresholds mirror CLAUDE.md's gates. They only apply when this
// config is run with `--coverage` — the plain `test:unit` script stays fast
// and uninstrumented. Path-scoped thresholds bite the moment domain/,
// application/, and infrastructure/ exist; against today's empty tree they
// simply have nothing to measure.
export default defineConfig({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      thresholds: {
        "src/domain/**": { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/application/**": { statements: 90, branches: 90, functions: 90, lines: 90 },
        "src/infrastructure/**": { statements: 70, branches: 70, functions: 70, lines: 70 },
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
