-- Bounded read models. The MCP role can read only these views; it has no access to base tables,
-- raw webhook bodies, stored idempotency responses or anything in the provider database.
CREATE SCHEMA readmodel;

CREATE VIEW readmodel.runs AS SELECT run_id, created_at FROM runs;
CREATE VIEW readmodel.demo_accounts AS SELECT account_id, run_id, created_at FROM demo_accounts;

CREATE VIEW readmodel.transfers AS
  SELECT transfer_id, run_id, account_id, asset, amount_minor, destination, note, state,
         provider_reference, version, last_provider_status, last_provider_sequence,
         last_provider_observed_at, last_provider_observation_id, created_at, updated_at
    FROM transfers;

CREATE VIEW readmodel.idempotency_keys AS
  SELECT account_id, operation_kind, idem_key, fingerprint, transfer_id, created_at
    FROM idempotency_keys;

CREATE VIEW readmodel.journal_batches AS
  SELECT batch_id, run_id, transfer_id, phase, created_at FROM journal_batches;

CREATE VIEW readmodel.journal_postings AS
  SELECT posting_id, batch_id, run_id, ledger_account, asset, amount_minor FROM journal_postings;

CREATE VIEW readmodel.account_balances AS
  SELECT run_id, ledger_account, asset, balance_minor, must_be_nonnegative FROM account_balances;

CREATE VIEW readmodel.provider_attempts AS
  SELECT attempt_id, run_id, transfer_id, provider_reference, kind, attempt_no, lease_token,
         started_at, finished_at, outcome, http_status, detail
    FROM provider_attempts;

CREATE VIEW readmodel.provider_observations AS
  SELECT observation_id, run_id, transfer_id, source, source_id, status, provider_sequence,
         final_no_effect, occurred_at, observed_at, decision, provider_note
    FROM provider_observations;

CREATE VIEW readmodel.webhook_events AS
  SELECT event_id, payload_hash, provider_reference, transfer_id, run_id, status,
         provider_sequence, occurred_at, received_at, processed_at, decision
    FROM webhook_inbox;

CREATE VIEW readmodel.webhook_deliveries AS
  SELECT delivery_id, event_id, transfer_id, payload_hash, received_at, result
    FROM webhook_deliveries;

CREATE VIEW readmodel.trace_events AS
  SELECT event_id, run_id, transfer_id, seq, type, source, recorded_at, correlation_id,
         causation_id, facts, untrusted
    FROM trace_events;

CREATE VIEW readmodel.journal_account_totals AS
  SELECT run_id, ledger_account, asset, sum(amount_minor) AS total_minor
    FROM journal_postings GROUP BY run_id, ledger_account, asset;

-- Exceptions are three distinct categories. Being unresolved is not an invariant violation.
CREATE VIEW readmodel.exception_items AS
  SELECT 'unknown_outcome:' || t.transfer_id AS item_id,
         t.run_id, t.account_id, 'unknown_outcome'::text AS kind,
         'provider_outcome_unresolved'::text AS reason,
         t.transfer_id,
         'Submission began but no authoritative provider evidence has been recorded. Funds stay reserved.'::text AS detail,
         coalesce((SELECT jsonb_agg(e.event_id ORDER BY e.seq) FROM trace_events e
                    WHERE e.transfer_id = t.transfer_id AND e.type = 'outcome_unknown'), '[]'::jsonb) AS evidence_ids,
         t.updated_at AS since
    FROM transfers t
   WHERE t.state = 'outcome_unknown'
  UNION ALL
  SELECT x.exception_id, x.run_id, t.account_id, x.kind, x.reason, x.transfer_id, x.detail,
         x.evidence_ids, x.created_at
    FROM exceptions x JOIN transfers t ON t.transfer_id = x.transfer_id
  UNION ALL
  SELECT 'invariant_failure:I5:' || t.transfer_id, t.run_id, t.account_id, 'invariant_failure',
         'terminal_state_journal_mismatch', t.transfer_id,
         'Transfer state ' || t.state || ' disagrees with its terminal journal batches.',
         coalesce((SELECT jsonb_agg(b.batch_id ORDER BY b.created_at) FROM journal_batches b
                    WHERE b.transfer_id = t.transfer_id), '[]'::jsonb),
         t.updated_at
    FROM transfers t
   WHERE (t.state = 'settled') <> EXISTS (SELECT 1 FROM journal_batches b
                                           WHERE b.transfer_id = t.transfer_id AND b.phase = 'settle')
      OR (t.state = 'rejected') <> EXISTS (SELECT 1 FROM journal_batches b
                                            WHERE b.transfer_id = t.transfer_id AND b.phase = 'release')
  UNION ALL
  SELECT 'invariant_failure:I2:' || b.run_id || ':' || b.ledger_account, b.run_id,
         CASE WHEN b.ledger_account LIKE 'user:%' THEN split_part(b.ledger_account, ':', 2) END,
         'invariant_failure', 'projection_journal_mismatch', NULL,
         'Projected balance ' || b.balance_minor || ' differs from journal total ' || coalesce(j.total_minor, 0)
           || ' for ' || b.ledger_account || '.',
         '[]'::jsonb, NULL
    FROM account_balances b
    LEFT JOIN readmodel.journal_account_totals j USING (run_id, ledger_account, asset)
   WHERE b.balance_minor <> coalesce(j.total_minor, 0);

REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Application role: no DELETE anywhere; no UPDATE on journal, trace, idempotency or evidence rows.
GRANT USAGE ON SCHEMA public, readmodel TO prl_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public, readmodel TO prl_app;
GRANT INSERT ON runs, demo_accounts, destinations, transfers, idempotency_keys, journal_batches,
  journal_postings, account_balances, jobs, provider_attempts, webhook_inbox, webhook_deliveries,
  provider_observations, trace_events, exceptions TO prl_app;
-- UPDATE on demo_accounts exists only so the row can be locked with SELECT ... FOR UPDATE.
GRANT UPDATE ON transfers, account_balances, jobs, provider_attempts, webhook_inbox, demo_accounts TO prl_app;

-- Investigation role: read-only views, nothing else.
GRANT USAGE ON SCHEMA readmodel TO prl_mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA readmodel TO prl_mcp_ro;
