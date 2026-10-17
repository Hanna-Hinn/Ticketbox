-- A client's Idempotency-Key, so a retry can be recognised as the same
-- order (TB-029). Nullable: the header is optional until TB-030 makes it
-- required, and UNIQUE admits any number of NULLs, so orders placed without
-- one are unconstrained by it. The constraint is the truth; TB-030's Redis
-- layer is the speed in front of it.
-- Named, because the adapter translates this one violation into the
-- domain's word for it; a rename must not turn that 409 into a 500.
ALTER TABLE orders ADD COLUMN idempotency_key text CONSTRAINT orders_idempotency_key_key UNIQUE;
