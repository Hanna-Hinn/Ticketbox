import { expect, test } from "@playwright/test";

// Handbook §4.1 E2E-1: the read path, browser → API → Postgres. The seed is
// fixed (SEED_EVENTS), so the strings are exact: 1000/200/0 for the jazz
// event, and the 0 reaches the screen as the label, not as "0 of 0".
const JAZZ_ID = "11111111-1111-4111-8111-111111111111";

test("browse events, open one, see three tiers with availability", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByTestId("event-list")).toBeVisible();
  await expect(page.getByTestId("event-card")).toHaveCount(3);

  await page.getByTestId("event-card").first().getByRole("link").click();

  await expect(page).toHaveURL(`/events/${JAZZ_ID}`);
  await expect(page.getByTestId("tier-row")).toHaveCount(3);
  await expect(page.getByTestId("tier-remaining")).toHaveText([
    "1000 of 1000",
    "200 of 200",
    "Sold out",
  ]);
  // One navigation entry: the click was handled in-app, not a full reload.
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
  expect(consoleErrors).toEqual([]);
});
