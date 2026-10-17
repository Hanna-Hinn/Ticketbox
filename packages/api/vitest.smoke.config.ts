import { defineConfig } from "vitest/config";

// Smoke hits a running API over real HTTP (SMOKE_BASE_URL, default
// http://localhost:3000). Nothing is started or faked here; if the API is
// not up, every test fails with a connection error, which is the answer.
export default defineConfig({
  test: {
    name: "smoke",
    include: ["test/smoke/**/*.test.ts"],
    environment: "node",
    testTimeout: 5_000,
  },
});
