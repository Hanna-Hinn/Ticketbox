import { defineConfig } from "@playwright/test";

// E2E runs against the compose stack, the API and the web app that are
// already up — locally via dev-up.sh + pnpm dev:api + pnpm dev:web, in CI
// via the integration job. Playwright starts nothing: if a server is not
// there, the "command" below fails fast and says which one, rather than
// booting a second stack against the wrong database.
const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:5173";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3000";

function notRunning(what: string, how: string): string {
  return `node -e "console.error('${what} is not reachable — start it with: ${how}'); process.exit(1)"`;
}

export default defineConfig({
  testDir: "e2e",
  // TB-037 fixes flakes properly; a retry here would hide them.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: notRunning("the API", "pnpm dev:api"),
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 5_000,
    },
    {
      command: notRunning("the web app", "pnpm dev:web"),
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 5_000,
    },
  ],
});
