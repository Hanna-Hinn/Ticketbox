-- The Postgres mirror of a hold (TB-024). Redis owns the live hold and its
-- TTL; this row is the audit trail. The token is the primary key because the
-- token *is* the hold's identity on the Redis side too.
CREATE TABLE holds (
  token      text        PRIMARY KEY,
  tier_id    uuid        NOT NULL REFERENCES ticket_tiers (id),
  qty        integer     NOT NULL CHECK (qty > 0),
  status     text        NOT NULL CHECK (status IN ('active', 'converted', 'expired', 'released')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
