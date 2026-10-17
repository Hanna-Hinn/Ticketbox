// Display only. The DTO carries cents with no currency; the seed prices are
// euros, so that is the display assumption until a DTO field says otherwise.
const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const when = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short" });

export function formatPrice(priceCents: number): string {
  return euros.format(priceCents / 100);
}

export function formatStartsAt(iso: string): string {
  return when.format(new Date(iso));
}
