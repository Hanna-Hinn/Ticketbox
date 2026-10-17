import { defineConfig } from "vitest/config";

// The client is a fetch wrapper with no DOM; tests inject fetch and build
// Responses with Node's global Response, so no browser environment is needed.
export default defineConfig({
  test: {
    name: "web-unit",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
