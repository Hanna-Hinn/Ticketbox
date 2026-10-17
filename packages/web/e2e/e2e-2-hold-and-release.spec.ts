import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Handbook §4.1 E2E-2, the part that exists before orders: get tickets, land
// on checkout, see a timer counting down, release, and see the number come
// back. Runs against the seeded stack: General has 1000 of 1000 and the
// seed wrote the live counters (TB-025), so the hold is real. Nothing here
// assumes how long a hold lives: CI runs the API with HOLD_TTL_MS=8000.
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

async function landOnCheckout(page: Page): Promise<string> {
  await expect(page).toHaveURL(CHECKOUT);
  token = CHECKOUT.exec(page.url())?.[1];
  if (token === undefined) throw new Error(`no token in ${page.url()}`);
  return token;
}

async function remainingMsOf(request: APIRequestContext, held: string): Promise<number> {
  const body: unknown = await (await request.get(`/api/holds/${held}`)).json();
  return typeof body === "object" && body !== null && "remainingMs" in body
    ? Number(body.remainingMs)
    : Number.NaN;
}

// "m:ss" → seconds.
function secondsShown(text: string | null): number {
  const match = /^(\d+):(\d\d)$/.exec(text ?? "");
  if (match === null) throw new Error(`not a countdown: ${String(text)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test("get two tickets, watch the countdown, release, see the number come back", async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(`/events/${JAZZ_ID}`);
  const general = page.getByTestId("tier-row").first();
  await expect(general.getByTestId("tier-remaining")).toHaveText("1000 of 1000");

  await general.getByTestId("qty").fill("2");
  await general.getByTestId("get-tickets").click();

  const held = await landOnCheckout(page);
  const countdown = page.getByTestId("countdown");
  // The stack decides the TTL (120 s for dev, shorter in CI); the spec asks
  // for a timer that reads what the server says is left — the browser
  // fetched a moment before the spec did and has ticked since, so within a
  // couple of seconds below — and that moves.
  await expect(countdown).toHaveText(/^\d+:\d\d$/);
  const serverSeconds = Math.ceil((await remainingMsOf(request, held)) / 1000);
  const first = await countdown.textContent();
  expect(secondsShown(first)).toBeGreaterThanOrEqual(serverSeconds - 2);
  expect(secondsShown(first)).toBeLessThanOrEqual(serverSeconds + 1);
  await expect(countdown).not.toHaveText(first ?? "");
  await expect(page.getByTestId("summary")).toContainText("Rooftop Jazz Night");
  await expect(page.getByTestId("summary")).toContainText("General");
  await expect(page.getByTestId("summary-qty")).toContainText("2");

  // The release's own reply, so a hold that expired under a slow run fails
  // as "released: false" and not as a number that did not come back.
  const releaseReply = page.waitForResponse((r) => r.request().method() === "DELETE");
  await page.getByTestId("release").click();
  expect(await (await releaseReply).text()).toBe('{"released":true}');

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
