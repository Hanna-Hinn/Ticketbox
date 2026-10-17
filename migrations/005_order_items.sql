-- "sold" for a tier is SUM(qty) over its order_items (handbook §1.5:
-- availability = total − sold − currently held).
CREATE TABLE order_items (
  id               uuid    PRIMARY KEY,
  order_id         uuid    NOT NULL REFERENCES orders (id),
  tier_id          uuid    NOT NULL REFERENCES ticket_tiers (id),
  qty              integer NOT NULL CHECK (qty > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0)
);
