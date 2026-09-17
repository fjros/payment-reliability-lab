# Implementation milestones

Completed in this order on 17 September 2026; evidence per milestone is in [DECISIONS.md](DECISIONS.md) and [VERIFICATION.md](VERIFICATION.md). A checked box means the behaviour exists and was verified locally against real dependencies, not that it was reviewed, committed or run in CI.

## 1. Runnable foundation

- [x] Confirm Node/npm/Docker availability; select compatible maintained libraries and pin a lockfile.
- [x] Add strict TypeScript, formatting/linting, test runner and executable development scripts.
- [x] Add PostgreSQL migrations, isolated local demo database setup and deterministic seed/reset commands.
- [x] Add a separate provider database/schema with restricted credentials.
- [x] Establish a real PostgreSQL integration test and a clean, documented teardown.

Exit: a fresh environment can migrate/seed an isolated demo DB and run one meaningful invariant test. No misleading passing placeholder tests.

## 2. Transfer acceptance and journal

- [x] Implement exact amounts, scoped idempotency and stable identity.
- [x] Atomically accept, reserve funds and schedule work.
- [x] Implement S1, same-key conflicts and distinct-key overspend races.
- [x] Add trace/read endpoints and account scoping.

Exit: concurrent and restarted-client tests prove one accepted transfer and one reservation, with balanced postings.

## 3. External failures and recovery

- [x] Implement durable, idempotent provider simulator and named fault controls.
- [x] Implement leased work, fencing/version protection and unknown-outcome recovery.
- [x] Implement verified webhook inbox, deduplication, ordering and terminal journal effects.
- [x] Prove S2/S3/S4/S5 with real HTTP/process/DB boundaries.

Exit: repeated requests and notifications cannot duplicate effects; uncertainty survives restarts without releasing funds. Trace and invariants explain every result.

## 4. MCP and reusable skill

- [x] Implement the three read-only tools, schemas, bounded results and read-only DB enforcement.
- [x] Test actual MCP transport, malicious inputs, missing evidence and permissions.
- [x] Implement the investigation skill and working project configuration.
- [x] Run deterministic rubrics; run live Claude Code scenarios if the user’s authenticated setup is available, otherwise report that limitation precisely.

Exit: tool results and agent diagnoses can be checked against known fixture truth. No fabricated transcripts or claims.

## 5. Viewer and replay

- [x] Build the trace/invariant/balance view, with responsive keyboard-accessible interactions.
- [x] Export real synthetic runs; label snapshots, unknown states and provenance.
- [x] Verify a static replay works without the API or model.

Exit: the five-minute walkthrough is reproducible; desktop and mobile screenshots have been inspected.

## 6. Open-source readiness

- [x] Rewrite README commands to match the actual implementation and limitations.
- [x] Add CI for lint/typecheck/tests/build and deterministic scenario checks, without deployment.
- [x] Document decisions, failure assumptions, scenario-to-test mapping and actual verification.
- [x] Review all files for secrets, private content and unsupported claims.
- [x] Leave all files uncommitted for owner review.

## Command contract (implemented)

`npm run dev`, `npm run db:migrate`, `npm run demo:seed`, `npm run demo:scenario -- S1`, `npm run demo:export -- S1`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run test:mcp`, `npm run test:e2e`, `npm run build`, `npm run mcp`.

These names may be simplified if the README and handoff remain consistent. Default `npm test` must not misleadingly imply all integration tests ran if it covers only units. Reset commands must target only the explicitly configured, seeded demo database, refuse unknown/nonlocal targets, and never remove unrelated Docker volumes.

## Later only if useful

gRPC, NATS, passkey auth, actual chain/reorg simulation, live hosting and CV integration are outside the initial implementation. Prefer a finished, explainable core over breadth. New features need a clear reason and explicit scope agreement.
