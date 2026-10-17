import { expect, test } from "@playwright/test";

// Handbook §4.1 E2E-2, the part that exists before orders: get tickets, land
// on checkout, see a timer counting down, release, and see the number come
// back. Runs against the seeded stack: General has 1000 of 1000 and the
// seed wrote the live counters (TB-025), so the hold is real.
const JAZZ_ID = "11111111-1111-4111-8111-111111111111";
// toHaveURL matches the whole URL, origin included; anchor the path at its end.
const CHECKOUT = /\/checkout\/([0-9a-f-]{36})$/;

// Nothing sweeps an abandoned hold yet (TB-026): a spec that fails between
// holding and releasing would leave the counter at 998 for every later spec
// and the next two minutes. Each spec records its token; cleanup releases
// it, which is a no-op for a hold the spec already released itself.
let token: string | undefined;

test.beforeEach(() => {
  token = undefined;
});

test.afterEach(async ({ request }) => {
  if (token !== undefined) await request.delete(`/api/holds/${token}`);
});

async function landOnCheckout(page: import("@playwright/test").Page): Promise<void> {
  await expect(page).toHaveURL(CHECKOUT);
  token = CHECKOUT.exec(page.url())?.[1];
}

test("get two tickets, watch the countdown, release, see the number come back", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(`/events/${JAZZ_ID}`);
  const general = page.getByTestId("tier-row").first();
  await expect(general.getByTestId("tier-remaining")).toHaveText("1000 of 1000");

  await general.getByTestId("qty").fill("2");
  await general.getByTestId("get-tickets").click();

  await landOnCheckout(page);
  const countdown = page.getByTestId("countdown");
  await expect(countdown).toHaveText(/^1:5\d$/);
  const first = await countdown.textContent();
  await expect(countdown).not.toHaveText(first ?? "");
  await expect(page.getByTestId("summary")).toContainText("Rooftop Jazz Night");
  await expect(page.getByTestId("summary")).toContainText("General");
  await expect(page.getByTestId("summary-qty")).toContainText("2");

  await page.getByTestId("release").click();

  await expect(page).toHaveURL(`/events/${JAZZ_ID}`);
  await expect(page.getByTestId("tier-remaining").first()).toHaveText("1000 of 1000");
  expect(browserErrors).toEqual([]);
});

test("the number drops while the hold is alive, as seen from a fresh load", async ({ page }) => {
  await page.goto(`/events/${JAZZ_ID}`);
  await page.getByTestId("tier-row").first().getByTestId("get-tickets").click();
  await landOnCheckout(page);

  await page.goto(`/events/${JAZZ_ID}`);
  await expect(page.getByTestId("tier-remaining").first()).toHaveText("999 of 1000");

  // Leave the stack as it was found.
  await page.goBack();
  await page.getByTestId("release").click();
  await expect(page.getByTestId("tier-remaining").first()).toHaveText("1000 of 1000");
});
