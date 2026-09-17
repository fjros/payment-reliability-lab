# Scope and motivation

Prepared 17 September 2026. This is a self-contained implementation brief for an independent open-source demonstration.

## Why build it

Demonstrate engineering judgment at the boundary between a local transaction and an external financial provider: stable identities, failure recovery, evidence, concurrency and an honest explanation of uncertainty. A reviewer should be able to inspect a small implementation, run deterministic scenarios and understand the guarantees.

The [Ethena Pay Senior/Staff Engineer posting](https://careers.ethena.fi/jobs/8157767-senior-staff-software-engineer-ethena-pay) motivated this exercise through its emphasis on reliable money movement, APIs, real-dependency testing and agentic development. This project is not affiliated with Ethena, contains no proprietary architecture and does not attempt to recreate its product.

## v1 deliverables

- A synthetic transfer API backed by PostgreSQL, with exact amounts and durable idempotency.
- A separate deterministic HTTP provider simulator with persistent acceptance records and signed webhook fixtures.
- A recoverable worker and local journal that demonstrate the three specified failures.
- Real-dependency integration tests, including concurrency and process restarts.
- Structured traces and executable invariants available through read-only MCP tools.
- A reusable Claude Code investigation skill and both deterministic and live-agent evaluation instructions.
- A clear local visualization and a static replay export with a five-minute walkthrough.
- Honest documentation of assumptions, guarantees, limitations and actual verification.

## Exclusions

No real money, private keys, live bank integration, actual blockchain settlement, trading strategies, personal CV data or employer data. No claims of production readiness, regulatory compliance or universal exactly-once delivery. No mobile app, production identity platform, distributed broker cluster, hosting infrastructure or grand payment framework.

A local backend and an optional static replay are enough. The eventual open-source repository is the primary deliverable; integrating the replay into a CV site is a later, separate action. Do not modify any other repository while building this one.

## Definition of success

A fresh clone can reproduce the three failures using documented commands, verify the invariants without a model, and inspect the same evidence through the UI and MCP. With Claude Code connected, the agent can distinguish duplicate delivery from duplicate effect and unknown outcome from proven failure. It reports evidence IDs and does not fabricate a resolution.
