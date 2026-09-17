-- Application schema. Roles prl_app and prl_mcp_ro are created by the bootstrap step
-- (src/db/bootstrap.ts) before migrations run; grants live in 002_grants.sql.

CREATE TABLE runs (
  run_id      text PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  created_at  timestamptz NOT NULL
);

-- A demo account is a local identity stub. Its row is the stable lock taken when checking and
-- reserving funds, so two distinct transfers cannot overspend concurrently.
CREATE TABLE demo_accounts (
  account_id  text PRIMARY KEY CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  run_id      text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL
);

CREATE TABLE destinations (
  destination_id text PRIMARY KEY
);

CREATE TABLE transfers (
  transfer_id                   text PRIMARY KEY,
  run_id                        text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  account_id                    text NOT NULL REFERENCES demo_accounts (account_id),
  asset                         text NOT NULL CHECK (asset = 'DEMO_USD'),
  amount_minor                  numeric(20, 0) NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  destination                   text NOT NULL REFERENCES destinations (destination_id),
  note                          text CHECK (note IS NULL OR char_length(note) <= 512),
  state                         text NOT NULL CHECK (state IN
                                  ('reserved', 'submitting', 'provider_pending', 'outcome_unknown', 'settled', 'rejected')),
  provider_reference            text NOT NULL UNIQUE,
  version                       integer NOT NULL DEFAULT 1,
  last_provider_status          text,
  last_provider_sequence        integer,
  last_provider_observed_at     timestamptz,
  last_provider_observation_id  text,
  created_at                    timestamptz NOT NULL,
  updated_at                    timestamptz NOT NULL
);
CREATE INDEX transfers_account_idx ON transfers (account_id, created_at, transfer_id);
CREATE INDEX transfers_run_state_idx ON transfers (run_id, state);

-- Terminal states never regress (I5). Enforced below the application as a last line of defence.
CREATE FUNCTION transfers_guard_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('settled', 'rejected') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'terminal transfer state % cannot change to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transfer_id <> OLD.transfer_id OR NEW.provider_reference <> OLD.provider_reference
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.asset <> OLD.asset
     OR NEW.destination <> OLD.destination OR NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION 'transfer identity and economic fields are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transfers_guard_terminal BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_guard_terminal();

-- Idempotency keys are scoped to (demo account, operation kind, key) and retained indefinitely.
CREATE TABLE idempotency_keys (
  account_id      text NOT NULL REFERENCES demo_accounts (account_id) ON DELETE CASCADE,
  operation_kind  text NOT NULL,
  idem_key        text NOT NULL,
  fingerprint     text NOT NULL,
  transfer_id     text NOT NULL UNIQUE REFERENCES transfers (transfer_id) ON DELETE CASCADE
                    DEFERRABLE INITIALLY DEFERRED,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL,
  PRIMARY KEY (account_id, operation_kind, idem_key)
);

-- Minimal signed-posting journal. One batch per (transfer, phase); settle and release are
-- mutually exclusive through the partial unique index.
CREATE TABLE journal_batches (
  batch_id     text PRIMARY KEY,
  run_id       text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id  text REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  phase        text NOT NULL CHECK (phase IN ('seed', 'reserve', 'settle', 'release')),
  created_at   timestamptz NOT NULL,
  CHECK ((phase = 'seed') = (transfer_id IS NULL))
);
CREATE UNIQUE INDEX journal_batches_phase_once ON journal_batches (transfer_id, phase)
  WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX journal_batches_one_terminal ON journal_batches (transfer_id)
  WHERE phase IN ('settle', 'release');

CREATE TABLE journal_postings (
  posting_id      text PRIMARY KEY,
  batch_id        text NOT NULL REFERENCES journal_batches (batch_id) ON DELETE CASCADE,
  run_id          text NOT NULL,
  ledger_account  text NOT NULL,
  asset           text NOT NULL CHECK (asset = 'DEMO_USD'),
  amount_minor    numeric(20, 0) NOT NULL CHECK (amount_minor <> 0)
);
CREATE INDEX journal_postings_batch_idx ON journal_postings (batch_id);
CREATE INDEX journal_postings_account_idx ON journal_postings (run_id, ledger_account, asset);

-- Every batch must sum to zero per asset at commit time (I2).
CREATE FUNCTION journal_batch_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT asset, sum(amount_minor) AS total INTO bad
    FROM journal_postings WHERE batch_id = NEW.batch_id
    GROUP BY asset HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal batch % does not balance for % (sum %)', NEW.batch_id, bad.asset, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_postings_balanced AFTER INSERT ON journal_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_batch_balanced();

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER journal_postings_immutable BEFORE UPDATE ON journal_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_batches_immutable BEFORE UPDATE ON journal_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rebuildable projection of the journal. The CHECK gives a database-level guard for I4.
CREATE TABLE account_balances (
  run_id          text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  ledger_account  text NOT NULL,
  asset           text NOT NULL CHECK (asset = 'DEMO_USD'),
  balance_minor   numeric(24, 0) NOT NULL,
  must_be_nonnegative boolean NOT NULL,
  PRIMARY KEY (run_id, ledger_account, asset),
  CHECK (NOT must_be_nonnegative OR balance_minor >= 0)
);

-- Durable job intent, written in the acceptance transaction. Leases are fenced by lease_token.
CREATE TABLE jobs (
  job_id            text PRIMARY KEY,
  run_id            text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id       text NOT NULL UNIQUE REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind = 'drive_transfer'),
  state             text NOT NULL CHECK (state IN ('pending', 'done')),
  run_after         timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  lease_owner       text,
  lease_token       integer NOT NULL DEFAULT 0,
  lease_expires_at  timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX jobs_due_idx ON jobs (state, run_after);

-- Every outbound provider call (submit or lookup), including failed ones.
CREATE TABLE provider_attempts (
  attempt_id          text PRIMARY KEY,
  run_id              text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id         text NOT NULL REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  provider_reference  text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('submit', 'lookup')),
  attempt_no          integer NOT NULL,
  lease_token         integer NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  outcome             text CHECK (outcome IN ('pending', 'completed', 'rejected', 'response_lost', 'timeout',
                        'http_error', 'not_found', 'inconclusive', 'conflict', 'invalid_response', 'abandoned')),
  http_status         integer,
  detail              text,
  UNIQUE (transfer_id, attempt_no)
);

-- Verified webhook envelopes, persisted before acknowledging. raw_body stays out of read models.
CREATE TABLE webhook_inbox (
  event_id            text PRIMARY KEY,
  payload_hash        text NOT NULL,
  raw_body            text NOT NULL,
  provider_reference  text NOT NULL,
  transfer_id         text REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  run_id              text REFERENCES runs (run_id) ON DELETE CASCADE,
  status              text NOT NULL,
  provider_sequence   integer NOT NULL,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL,
  processed_at        timestamptz,
  decision            text
);
CREATE INDEX webhook_inbox_unprocessed_idx ON webhook_inbox (received_at) WHERE processed_at IS NULL;

CREATE TABLE webhook_deliveries (
  delivery_id   text PRIMARY KEY,
  event_id      text NOT NULL,
  transfer_id   text REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL,
  result        text NOT NULL CHECK (result IN ('accepted', 'duplicate', 'event_id_conflict'))
);
CREATE INDEX webhook_deliveries_event_idx ON webhook_deliveries (event_id);

-- Every piece of provider evidence the application actually saw, whatever its channel.
CREATE TABLE provider_observations (
  observation_id      text PRIMARY KEY,
  run_id              text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id         text NOT NULL REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  source              text NOT NULL CHECK (source IN ('submit_response', 'lookup', 'webhook')),
  source_id           text NOT NULL,
  status              text NOT NULL,
  provider_sequence   integer,
  final_no_effect     boolean NOT NULL DEFAULT false,
  occurred_at         timestamptz,
  observed_at         timestamptz NOT NULL,
  decision            text NOT NULL,
  provider_note       text
);
CREATE INDEX provider_observations_transfer_idx ON provider_observations (transfer_id, observed_at);

-- Append-only audit trace with a per-transfer sequence.
CREATE TABLE trace_events (
  event_id        text PRIMARY KEY,
  run_id          text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id     text NOT NULL REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  type            text NOT NULL,
  source          text NOT NULL,
  recorded_at     timestamptz NOT NULL,
  correlation_id  text NOT NULL,
  causation_id    text,
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  untrusted       jsonb,
  UNIQUE (transfer_id, seq)
);
CREATE TRIGGER trace_events_immutable BEFORE UPDATE ON trace_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Recorded exceptions (conflicting observations). Unknown outcomes and invariant failures are
-- derived in read models so they cannot drift from the underlying state.
CREATE TABLE exceptions (
  exception_id  text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  transfer_id   text NOT NULL REFERENCES transfers (transfer_id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('conflicting_observation')),
  reason        text NOT NULL,
  detail        text NOT NULL,
  evidence_ids  jsonb NOT NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX exceptions_run_idx ON exceptions (run_id, created_at, exception_id);
