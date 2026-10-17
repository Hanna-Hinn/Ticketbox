import { defineConfig } from "@playwright/test";

// E2E runs against the compose stack, the API and the web app that are
// already up — locally via dev-up.sh + pnpm dev:api + pnpm dev:web, in CI
// via the integration job. Playwright starts nothing: if a server is not
// there, the "command" below fails fast and says which one, rather than
// booting a second stack against the wrong database. The API is checked
// through the web app's proxy, the only path the browser will use.
// E2E-3 (TB-028a) also needs the sweeper worker (pnpm dev:worker), which has
// no port to check; its absence shows up as that spec's own failure message.
// CI starts the API with HOLD_TTL_MS=8000 so the expiry journey takes
// seconds; the specs ask the server how long a hold has rather than assume.
const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:5173";

function notAnswering(what: string, url: string, how: string): string {
  return `node -e "console.error('${what} is not answering at ${url} (not started, or its health check is failing) - start it with: ${how}'); process.exit(1)"`;
}

export default defineConfig({
  testDir: "e2e",
  // TB-037 fixes flakes properly; a retry here would hide them.
  retries: 0,
  // One stack, one seed, one live counter: a spec that holds tickets changes
  // the number every other spec reads. The journeys run one at a time.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  webServer: [
    {
      command: notAnswering("the web app", WEB_URL, "pnpm dev:web"),
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 5_000,
    },
    {
      command: notAnswering("the API", `${WEB_URL}/api/health`, "pnpm dev:api"),
      url: `${WEB_URL}/api/health`,
      reuseExistingServer: true,
      timeout: 5_000,
    },
  ],
});
