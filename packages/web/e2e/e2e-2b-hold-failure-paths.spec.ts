import { expect, test, type Page } from "@playwright/test";

// The checkout page's failure paths, each one a thing the browser must NOT
// decide for itself: when a hold is over, whether a tier is sold out, and
// what to do when a release fails. The server answers; the page shows it.
const JAZZ_ID = "11111111-1111-4111-8111-111111111111";
const CHECKOUT = /\/checkout\/([0-9a-f-]{36})$/;
const TEN_MINUTES = 10 * 60_000;

let token: string | undefined;

test.beforeEach(() => {
  token = undefined;
});

test.afterEach(async ({ request }) => {
  if (token !== undefined) await request.delete(`/api/holds/${token}`);
});

async function holdOneGeneral(page: Page): Promise<string> {
  await page.goto(`/events/${JAZZ_ID}`);
  await page.getByTestId("tier-row").first().getByTestId("get-tickets").click();
  await expect(page).toHaveURL(CHECKOUT);
  token = CHECKOUT.exec(page.url())?.[1];
  if (token === undefined) throw new Error(`no token in ${page.url()}`);
  return token;
}

function countHoldReads(page: Page, token: string): () => number {
  let reads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith(`/api/holds/${token}`)) reads += 1;
  });
  return () => reads;
}

test("a browser clock ahead of the server asks the server once, never in a loop", async ({
  page,
}) => {
  // The fake clock must be installed before the page creates its interval:
  // installed afterwards, the page's real interval can never be cleared by
  // the fake clearInterval and the test would report a loop the app does
  // not have.
  await page.clock.install({ time: Date.now() });
  const held = await holdOneGeneral(page);
  await expect(page.getByTestId("countdown")).toHaveText(/^1:5\d$/);
  const reads = countHoldReads(page, held);

  // The browser's clock jumps ten minutes ahead; the hold is still alive on
  // the server. The countdown must not read zero.
  await page.clock.setSystemTime(Date.now() + TEN_MINUTES);
  await page.clock.runFor(3_000);

  expect(reads()).toBe(0);
  await expect(page.getByTestId("countdown")).toHaveText(/^1:5\d$/);
  await expect(page.getByTestId("summary")).toBeVisible();
});

test("at zero the page asks the server once and shows what it says", async ({ page, request }) => {
  await page.clock.install({ time: Date.now() });
  const held = await holdOneGeneral(page);
  await expect(page.getByTestId("countdown")).toHaveText(/^1:5\d$/);
  const reads = countHoldReads(page, held);

  // The hold is released behind the page's back, then the browser reaches
  // the end of the countdown. One question to the server, one answer.
  await request.delete(`/api/holds/${held}`);
  await page.clock.runFor(2 * 60_000);

  await expect(page.getByTestId("hold-gone")).toBeVisible();
  await page.clock.runFor(3_000);
  expect(reads()).toBe(1);
  token = undefined;
});

test("a sold-out tier still offers the button, and the server's refusal is shown", async ({
  page,
}) => {
  await page.goto(`/events/${JAZZ_ID}`);
  const vip = page.getByTestId("tier-row").nth(2);
  await expect(vip.getByTestId("tier-remaining")).toHaveText("Sold out");

  await vip.getByTestId("get-tickets").click();

  await expect(vip.getByTestId("hold-error")).toContainText("not enough tickets");
  await expect(page).toHaveURL(`/events/${JAZZ_ID}`);
  await expect(vip.getByTestId("tier-remaining")).toHaveText("Sold out");
});

test("a release that fails leaves the hold on screen with the error and the button live", async ({
  page,
}) => {
  await holdOneGeneral(page);
  await page.route(
    (url) => url.pathname.startsWith("/api/holds/"),
    async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "redis is away" } }),
      });
    },
  );

  await page.getByTestId("release").click();

  await expect(page.getByTestId("release-error")).toContainText("503");
  await expect(page.getByTestId("release")).toBeEnabled();
  await expect(page).toHaveURL(CHECKOUT);
  await expect(page.getByTestId("summary")).toBeVisible();
});
