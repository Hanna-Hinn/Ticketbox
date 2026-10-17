// Display only. The DTO carries cents and no currency, and the seed does not
// say which one. EUR is a UI assumption until the DTO carries a currency.
// TODO(tech-debt): add `currency` to TierResponse (TB-015 shares the types)
// so the browser stops assuming it.
const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const when = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short" });

export function formatPrice(priceCents: number): string {
  return euros.format(priceCents / 100);
}

export function formatStartsAt(iso: string): string {
  return when.format(new Date(iso));
}
