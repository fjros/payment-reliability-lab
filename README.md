# Payment Reliability Lab

A small, inspectable TypeScript + PostgreSQL lab for what happens when payment requests time out,
notifications repeat or arrive out of order, and an external outcome is genuinely unknown. It
combines a transfer API with a minimal balanced journal, a recoverable worker, a deterministic
provider simulator with its own persistent state, a read-only MCP investigation interface and a
static trace viewer.

All accounts, funds and providers are synthetic (`DEMO_USD` is not money). This is an independent
educational project: not a production payment system, and not an implementation of any
employer's systems.

**Status (17 September 2026): milestones 1–6 of [the plan](docs/IMPLEMENTATION_PLAN.md) are
implemented and verified locally and in CI.** The source is public, with an interactive replay on GitHub Pages. The API and database remain local.
Exact commands and results are in [docs/VERIFICATION.md](docs/VERIFICATION.md); decisions and the
progress log are in [docs/DECISIONS.md](docs/DECISIONS.md); what is *not* covered is under
[Limitations](#limitations).

## Explore without setup

[Interactive replay](https://fjros.github.io/payment-reliability-lab/) ·
[Captioned walkthrough](https://fjros.github.io/payment-reliability-lab/media/walkthrough-v1.mp4) ·
[Transcript and recorded Claude investigation](https://fjros.github.io/payment-reliability-lab/media/transcript.html)

The public viewer lets you scrub through reviewed scenario traces, inspect journal entries and
follow causal links. These are exported runs, not fresh backend execution. The walkthrough also
includes genuine output from a separate Claude Code session using the three read-only MCP tools.
See [walkthrough provenance](docs/WALKTHROUGH.md).

`npm run build:public` builds the replay-only site; `npm run test:public` checks it in Chromium.
The manual **Publish interactive replay** workflow publishes only `dist/web` to GitHub Pages.
The regular local viewer retains its Live API tab.

## What it demonstrates

1. **S1 — lost response, client retry.** The API commits a transfer, the connection is really
   dropped before the response, the client retries: same transfer, one reservation, one settlement.
2. **S2 — duplicate and out-of-order webhooks.** Five deliveries of three provider events produce
   one settlement; duplicates and a stale older event are recorded and ignored; contradictions
   become exceptions, never automatic corrections.
3. **S3 — provider accepted, response disappeared.** The worker persists `outcome_unknown`, keeps
   funds reserved and the same provider reference across restarts, and settles (or releases) only
   on authoritative evidence. A timeout is never treated as a rejection.
4. **Evidence-based investigation.** An agent uses three read-only MCP tools to explain a
   transfer, cites evidence IDs, says "unknown" when it is unknown and ignores instructions
   embedded in provider notes (S7, S8).

## Quick start

Prerequisites: Node.js 24, npm, a Docker-compatible runtime. Claude Code is optional.

```bash
npm ci
npm run db:up            # local PostgreSQL 17 on 127.0.0.1:54329 (docker compose)
npm run db:migrate       # creates the app + provider databases, roles and schema
npm run demo:scenario -- all     # runs S1, S2, S3, S7, S8 deterministically and prints the evidence
```

Then explore:

```bash
npm run build && npx vite preview --config web/vite.config.ts   # static replay viewer, http://127.0.0.1:4173
npm run demo:export -- all       # write replay JSON to artifacts/local/ (git-ignored)

npm run demo:seed && npm run dev # API :4010, worker, provider simulator :4020 as three processes
npm run dev:web                  # viewer with a "Live API" tab (read-only proxy to the local API)
```

With `npm run dev` running you can create a transfer yourself:

```bash
curl -s -X POST http://127.0.0.1:4010/v1/transfers \
  -H 'content-type: application/json' -H 'x-demo-account: demo-alice' -H 'idempotency-key: my-key-1' \
  -d '{"asset":"DEMO_USD","amountMinor":"2500","destination":"demo:merchant-2"}'
# repeat it: same transferId, header Idempotent-Replayed: true. Change the amount: 409.
```

`npm run db:down` stops PostgreSQL (the volume is kept). `npm run demo:reset` drops and recreates
only the two configured lab databases; it refuses non-loopback hosts and unexpected database
names and never touches Docker volumes.

## Commands

| Command | What it does |
|---|---|
| `npm test` / `npm run test:unit` | **Unit tests only** (no Docker): amounts, fingerprints, state machine, journal rules, signatures, OpenAPI sync |
| `npm run test:integration` | Real PostgreSQL via Testcontainers: S1–S5, HTTP contract, webhooks, recovery, real process kills. Fails (does not skip) without Docker |
| `npm run test:mcp` | Builds, then drives the MCP server over a real stdio transport with a read-only DB role |
| `npm run test:e2e` | Builds the viewer, then Playwright against the static build with no backend |
| `npm run test:all` | All of the above |
| `npm run typecheck`, `npm run lint`, `npm run format` | Strict TypeScript (server, viewer, e2e), ESLint + Prettier |
| `npm run build` | `dist/` (server + MCP entry point) and `dist/web` (static viewer) |
| `npm run demo:scenario -- <S1\|S2\|S3\|S7\|S8\|all> [--seed=1] [--stop-at-unknown]` | Deterministic scenario run in its own run namespace `<id>-<seed>` (purged and recreated each time) |
| `npm run demo:export -- <id\|all> [--out=web/public/replays]` | Versioned replay JSON from an actual run |
| `npm run mcp` | The read-only MCP server on stdio (normally started by the MCP client) |
| `npm run openapi` | Regenerates [docs/openapi.json](docs/openapi.json) from the server's validation schemas |

## Guarantees, and what they rest on

No "exactly once" claim is made across systems. Precisely:

| Guarantee | Protected by | Assumption |
|---|---|---|
| One logical transfer per `(demo account, operation, idempotency key)` and economic payload | Primary key on `idempotency_keys`; fingerprint of asset + amount + destination; one acceptance transaction | Keys are retained indefinitely (demo choice); the `note` is ancillary, first write wins |
| One reservation; at most one terminal journal effect; settle and release mutually exclusive | Unique indexes on journal batches, transfer row lock, single evidence-handling function | — |
| No overdraw under concurrency | Per-account row lock + database `CHECK` on the projection | — |
| Every batch balances; projection equals journal | Deferred constraint trigger; invariant I2; immutable postings (no UPDATE/DELETE grant, trigger) | — |
| Terminal states never regress | State machine + database trigger | — |
| A stale worker cannot overwrite a newer result | Lease token fencing inside the writing transaction + monotonic transitions | Clock skew may let two workers hold a lease at once; correctness rests on the token and the provider's idempotency, not on the clock |
| A timeout / lost response / 5xx / "not found" never releases funds or mints a new payment | `outcome_unknown` state; release only on an explicit final no-effect rejection; one stable provider reference | — |
| **At most one external effect** | **Not provable by the application.** It relies on the provider applying at most one effect per `providerReference` | The simulator honours this contract (tests verify it through a privileged oracle); a real provider must too |
| MCP cannot change anything | DB role with `SELECT` on `readmodel` views only, read-only transactions by default, no base-table or provider-database access; no mutating tools exist | Tool annotations and skill prose are *not* the boundary |

Local database effects are atomic; network calls are not. No database transaction is held across
a provider HTTP call.

## Layout

```
migrations/app, migrations/provider   explicit SQL (tables, constraints, triggers, read-model views, grants)
src/domain        amounts, fingerprint, state machine, journal rules (pure)
src/app           acceptance transaction, evidence handling, webhook intake, invariants, read models
src/api           Fastify API, webhook signature verification, OpenAPI generator
src/worker        leased jobs, provider client, unknown-outcome recovery, inbox processing
src/provider-sim  simulator HTTP contract, persistent store, harness-only control + oracle
src/mcp           three read-only tools over a snapshot-isolated, read-only connection
src/scenarios     deterministic scenario scripts, in-process stack, replay export, CLI
web/              static trace viewer (vanilla TypeScript + Vite) and reviewed replay examples
tests/            unit, integration (Testcontainers), mcp (stdio), e2e (Playwright), harness
.claude/skills/investigate-transfer   the reusable investigation skill;  .mcp.json  project MCP config
evals/            agent fixtures, rubric, runner and the recorded live-run summary
```

## Investigating with Claude Code

```bash
npm run demo:scenario -- all && npm run demo:scenario -- S3 --stop-at-unknown
npm run build:server
claude            # from the repository root; approve the project MCP server "payment-reliability-lab"
> /investigate-transfer tr_… S3-1
```

`.mcp.json` starts `node dist/mcp/main.js` with no credentials or absolute paths in it; the server
reads the same local demo defaults as everything else and discloses only the runs listed in
`PRL_MCP_RUN_IDS`. For a session restricted to the three tools, and for the rubric and the
recorded live run, see [evals/README.md](evals/README.md) and
[evals/runs/2026-09-17-claude-code-live.md](evals/runs/2026-09-17-claude-code-live.md).
Deterministic tests never call a model.

## Five-minute walkthrough

See [docs/DEMO.md](docs/DEMO.md#five-minute-walkthrough-as-implemented).

## Limitations

- Educational scope: one fake asset, no FX/fees/rounding, no production authentication
  (`X-Demo-Account` is an identity stub), loopback only, no rate limiting, no key-retention policy.
- One PostgreSQL server hosts both databases; separated credentials do not simulate independent
  database-server outages. Process crashes are tested (real `SIGKILL`/exit for two variants,
  in-process simulated crashes elsewhere); machine, disk and network-partition faults are not.
- The provider simulator's idempotency contract is an assumption about real providers, not a fact.
- Polling of `provider_pending` transfers uses a fixed delay with no cap or dead-letter policy.
- Webhooks for an unknown provider reference are stored and marked, but do not appear in the
  account-scoped exception listing.
- The viewer has no "naive design" comparison, and its live mode observes one transfer at a time.
- The live agent evaluation is five single runs with one model; see its file for caveats.
- The public website replays exported test evidence; it cannot create transfers or run an agent.
  The backend and provider simulator run locally.

## Design documents

[Scope](docs/BRIEF.md) · [Architecture](docs/ARCHITECTURE.md) · [Domain and invariants](docs/DOMAIN.md) ·
[HTTP and provider contracts](docs/API.md) ([OpenAPI](docs/openapi.json)) · [Scenarios](docs/SCENARIOS.md) ·
[Testing strategy](docs/TESTING.md) · [Verification record](docs/VERIFICATION.md) ·
[MCP and skill](docs/AGENT_WORKFLOW.md) · [Viewer and walkthrough](docs/DEMO.md) ·
[Plan](docs/IMPLEMENTATION_PLAN.md) · [Decisions and progress](docs/DECISIONS.md) · [References](docs/REFERENCES.md)

Licensed under [MIT](LICENSE).
