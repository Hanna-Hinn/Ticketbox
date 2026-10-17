-- Money is integer cents, never floats (handbook: Money value object).
-- No index on event_id on purpose: TB-010 reads this unindexed so TB-013
-- has a slow baseline to measure the composite index against.
CREATE TABLE ticket_tiers (
  id          uuid        PRIMARY KEY,
  event_id    uuid        NOT NULL REFERENCES events (id),
  name        text        NOT NULL,
  price_cents integer     NOT NULL CHECK (price_cents >= 0),
  total_qty   integer     NOT NULL CHECK (total_qty >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
