import { expect, test, type APIRequestContext } from "@playwright/test";

// Handbook §4.1 E2E-3: get tickets, let the timer run out, and the number
// comes back without anyone doing anything — the TTL drops the hold, the
// countdown asks the server once and is told it is gone, the sweeper puts
// the quantity back from the index (TB-026). Real time, on purpose: the
// stack this runs against sets HOLD_TTL_MS short (8 s in CI); the spec
// never assumes a value — it asks the server how long is left and waits
// that long, so against the 120 s dev stack it is right and slow.
const JAZZ_ID = "11111111-1111-4111-8111-111111111111";
const CHECKOUT = /\/checkout\/([0-9a-f-]{36})$/;
// One sweeper tick is 5 s; a hold that expired is back within the next one.
const SWEEP_MARGIN_MS = 20_000;

let token: string | undefined;

// The body is unknown until it is looked at (the smoke suite's pattern); a
// 404 envelope has no remainingMs and comes out NaN, which fails the assertion.
async function remainingMsOf(request: APIRequestContext, held: string): Promise<number> {
  const body: unknown = await (await request.get(`/api/holds/${held}`)).json();
  return typeof body === "object" && body !== null && "remainingMs" in body
    ? Number(body.remainingMs)
    : Number.NaN;
}

test.beforeEach(() => {
  token = undefined;
});

// A no-op on this spec — the sweeper took the hold — and a safety net if
// the spec dies before the TTL does (after it, only the sweeper restores).
test.afterEach(async ({ request }) => {
  if (token !== undefined) await request.delete(`/api/holds/${token}`);
});

test("the timer runs out and the number comes back by itself", async ({ page, request }) => {
  const deletes: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "DELETE" && sent.url().includes("/api/holds/")) deletes.push(sent.url());
  });

  await page.goto(`/events/${JAZZ_ID}`);
  const general = page.getByTestId("tier-row").first();
  await expect(general.getByTestId("tier-remaining")).toHaveText("1000 of 1000");
  await general.getByTestId("get-tickets").click();
  await expect(page).toHaveURL(CHECKOUT);
  token = CHECKOUT.exec(page.url())?.[1];
  if (token === undefined) throw new Error(`no token in ${page.url()}`);
  await expect(page.getByTestId("countdown")).toBeVisible();

  // The server says how long the hold has; the spec waits that long, plus
  // the margins, and no longer.
  const remainingMs = await remainingMsOf(request, token);
  expect(remainingMs).toBeGreaterThan(0);
  test.setTimeout(remainingMs + SWEEP_MARGIN_MS + 30_000);

  // Nobody clicks: the countdown reaches zero, asks, is told the hold is
  // gone.
  await expect(page.getByTestId("hold-gone")).toBeVisible({ timeout: remainingMs + 5_000 });
  expect(deletes).toEqual([]);

  // And the number is back — the sweeper's doing, seen from a fresh read of
  // the page (the page does not update itself until TB-038).
  await expect
    .poll(
      async () => {
        await page.goto(`/events/${JAZZ_ID}`);
        return page.getByTestId("tier-remaining").first().textContent();
      },
      {
        timeout: SWEEP_MARGIN_MS,
        message: "availability did not return — is the sweeper running (pnpm dev:worker)?",
      },
    )
    .toBe("1000 of 1000");
  expect(deletes).toEqual([]);
});
