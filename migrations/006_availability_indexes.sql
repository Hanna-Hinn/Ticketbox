-- The availability query (PgEventRepository, TIERS_FOR_EVENTS) sums holds by
-- (tier_id, status = 'active') and order_items by tier_id, once per tier.
-- Without these, each sum is a sequential scan of a table that grows with
-- every hold ever made. docs/BENCHMARKS.md §1 has the before and after.
CREATE INDEX holds_tier_id_status_idx ON holds (tier_id, status);
CREATE INDEX order_items_tier_id_idx ON order_items (tier_id);
