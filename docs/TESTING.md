# Verification strategy

The strategy below is implemented; what was actually run, with results and the scenario-to-test mapping, is in [VERIFICATION.md](VERIFICATION.md).

## Unit and property-oriented checks

Test amount parsing/serialization boundaries, canonical fingerprints, valid/invalid transitions, error contracts and journal conservation. Use generated sequences where useful to discover repeated/out-of-order transition bugs; state the invariant, not merely the implementation’s current output.

## PostgreSQL integration tests

Use Testcontainers with real PostgreSQL, migrations and deterministic seed data. Pin a tested image version. Run the application and simulator against separate persistent state. Exercise unique constraints, account/transfer locks, transaction rollback, inbox persistence, job leases and read-only permissions. Do not replace these assertions with mocked repositories or SQLite.

Use coordinated concurrency to race requests and workers. Inject crashes at defined boundaries and restart processes against the same database. Make timeouts and cleanup bounded. Fail with a clear prerequisite message if Docker is unavailable; do not mark those tests passed or silently skip them.

## Contract and recovery tests

Test the HTTP contract and simulator’s persistent idempotency behavior. Distinguish failed HTTP responses from lost responses and from final provider rejection. Check malformed, oversized and unauthorized/scoped requests, including amount representation errors.

Webhook tests must verify raw-body signing and timestamps, duplicate event identity, duplicate business outcomes under different event IDs, reordered delivery and terminal contradictions. A dropped response after DB commit must be a real observable fault, not a stubbed function returning an already expected value.

## MCP boundary tests

Connect through an actual MCP client transport to exercise tool discovery, schemas, invocation and structured results. Attempt unknown tools, arbitrary SQL/path inputs, excessive limits and malformed IDs. Validate account/run scope. Use read-only DB credentials; attempt a write in a dedicated test and require the database to deny it. Confirm every tool is observational and execution leaves journal and transfer state unchanged.

Test completeness metadata, unknown provider evidence, unknown IDs and database outages. A failed query returns an explicit error, not an empty healthy result. Keep protocol JSON on stdout and diagnostic logs on stderr for stdio.

## Agent evaluations

Core CI tests tools, fixtures and rubric deterministically, without model credentials. Separately run a documented live Claude Code evaluation of S1/S2/S3/S7/S8. Record model identifier, date, fixture revision, tools actually used, evidence cited and rubric results. Do not fabricate a transcript or assert live-agent performance from a canned response. User authentication/billing remains user-controlled.

Score: grounded claims; correct effect counts; correct uncertainty; relevant invariant checks; no unauthorized action; refusal to follow embedded instructions. Correct but uncited conclusions are incomplete. Report variability and limitations.

## UI and exports

Use browser tests for scenario selection, timeline inspection, keyboard access, mobile layout, reduced motion and exported replay loading without a backend. Render arbitrary note strings as text, never HTML. Show API disconnects and stale snapshots explicitly. Test 390, 768 and 1440-pixel widths plus direct refresh of the static entry page.

## Required final evidence

A fresh-clone walkthrough, exact commands/results, scenario-to-test mapping, generated synthetic traces, one manually inspected live-agent run if access is available, and a list of unresolved limitations. CI should eventually run typecheck, lint, unit/integration/contract/MCP tests and a build; pin GitHub Actions to verified SHAs and give read-only permissions by default. Do not add automatic deployment or publish artifacts containing environment/session data.
