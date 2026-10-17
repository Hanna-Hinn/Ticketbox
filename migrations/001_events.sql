-- Kind A data (handbook §1.4): an event exists. Must survive a restart.
CREATE TABLE events (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,
  venue      text        NOT NULL,
  starts_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
