-- Provider simulator state. Lives in its own database with its own credentials; the application
-- roles cannot connect to it. It shares no transaction with the application.

CREATE TABLE sim_transfers (
  provider_reference  text PRIMARY KEY,
  asset               text NOT NULL,
  amount_minor        numeric(20, 0) NOT NULL CHECK (amount_minor > 0),
  destination         text NOT NULL,
  status              text NOT NULL CHECK (status IN ('pending', 'completed', 'rejected')),
  sequence            integer NOT NULL,
  provider_note       text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

-- The simulated external money movement. The primary key is the "at most one effect per
-- reference" guarantee; the scenario harness reads it as a privileged oracle.
CREATE TABLE sim_effects (
  provider_reference  text PRIMARY KEY REFERENCES sim_transfers (provider_reference) ON DELETE CASCADE,
  asset               text NOT NULL,
  amount_minor        numeric(20, 0) NOT NULL,
  applied_at          timestamptz NOT NULL
);

CREATE TABLE sim_webhook_outbox (
  event_id            text PRIMARY KEY,
  provider_reference  text NOT NULL REFERENCES sim_transfers (provider_reference) ON DELETE CASCADE,
  status              text NOT NULL,
  sequence            integer NOT NULL,
  occurred_at         timestamptz NOT NULL,
  body                text NOT NULL,
  forced              boolean NOT NULL DEFAULT false,
  delivery_count      integer NOT NULL DEFAULT 0,
  last_delivery_status integer,
  created_at          timestamptz NOT NULL
);
CREATE INDEX sim_webhook_outbox_ref_idx ON sim_webhook_outbox (provider_reference, sequence);

-- Deterministic fault plans, written only by the scenario harness (never over HTTP). Persisted
-- so a simulator restart keeps the same behaviour. provider_reference '*' is the default plan.
CREATE TABLE sim_fault_plans (
  provider_reference  text PRIMARY KEY,
  plan                jsonb NOT NULL,
  updated_at          timestamptz NOT NULL
);

GRANT USAGE ON SCHEMA public TO prl_provider;
GRANT SELECT, INSERT, UPDATE ON sim_transfers, sim_webhook_outbox, sim_fault_plans TO prl_provider;
GRANT SELECT, INSERT ON sim_effects TO prl_provider;
