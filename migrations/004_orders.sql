-- A hold converts to at most one order, hence UNIQUE on hold_token.
-- idempotency_key arrives with TB-029 as its own numbered migration.
CREATE TABLE orders (
  id          uuid        PRIMARY KEY,
  hold_token  text        NOT NULL UNIQUE REFERENCES holds (token),
  email       text        NOT NULL,
  total_cents integer     NOT NULL CHECK (total_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
