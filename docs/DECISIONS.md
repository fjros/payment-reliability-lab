# Decisions and progress

## Initial decisions — 17 September 2026 (bootstrap)

| Decision | Reason and consequence |
|---|---|
| Synthetic transfer lab, three core scenarios | Small enough to finish and review; no real financial authority |
| TypeScript + PostgreSQL | Makes transaction boundaries and exact-amount handling inspectable |
| Database-backed jobs in v1 | Demonstrates durable intent without adding broker operations |
| Separate provider state and real HTTP | Application cannot claim an external side effect was atomic with its own DB |
| Retain idempotency keys indefinitely in demo | Makes replay guarantees explicit; production retention is not solved here |
| One fake asset and integer minor units | Focus on reliability; no claim of FX or rounding coverage |
| Read-only MCP and a reusable investigation skill | Agent demonstrates evidence-based reasoning without remediation authority |
| Local service, optional static replay | Anyone can review exported behavior without running an agent/backend |
| MIT license; public repository | Simple reuse and review by others |
| No commits or pushes yet | Owner requested bootstrap only; Claude Code will implement |

## Implementation decisions — 17 September 2026

### Contradictions and gaps found in the specifications, and how they were resolved

| Finding | Resolution (invariant preserved) |
|---|---|
| `list_exceptions` takes a `runId` and MCP must enforce a "run/account scope", but the API/domain had no run concept | Every demo account belongs to a **run** (`runs` table). Scenarios execute in run `<scenario>-<seed>`. The MCP server discloses only runs in `PRL_MCP_RUN_IDS`; out-of-scope transfers are indistinguishable from missing ones. The HTTP API stays account-scoped |
| State table had no row for resubmitting from `outcome_unknown`, although DOMAIN/S3 allow resubmission of the same reference | State stays `outcome_unknown` during a resubmission; evidence from the response moves it on. Resubmission happens only after a lookup returned *not found*. Table in DOMAIN.md extended. I6/I7 unchanged |
| "Any nonterminal state after submission began" left `reserved` + provider evidence undefined | Treated as impossible evidence: `conflicting_observation` exception (`evidence_before_submission`), no journal effect |
| A `rejected` status without the explicit no-effect guarantee was unspecified | Exception (`rejection_without_no_effect_guarantee`); funds stay reserved (I7) |
| API.md lists `GET /v1/transfers/:id`, `/trace`, `/exceptions` only; the viewer and invariants need more | Added read-only `GET /v1/transfers`, `/v1/transfers/:id/evidence`, `/v1/transfers/:id/invariants`, `/v1/balances`. Documented in API.md and OpenAPI |
| ARCHITECTURE suggests `artifacts/examples/` for public replays; DEMO needs the static viewer to load them with no backend | Reviewed examples live in `web/public/replays/` so the built site is self-contained; `artifacts/local/` stays the git-ignored default output |
| Target command contract vs reality | Kept all names. `npm test` is explicitly unit-only; added `test:unit`, `test:all`, `db:up`, `db:down`, `demo:reset`, `dev:web`, `build:server`, `build:web`, `openapi`, `format` |
| Bootstrap `typescript` latest is 7.x, but `typescript-eslint` 8.70 supports `<6.1` | Pinned TypeScript 6.0.3 |

### Material design choices

| Decision | Reason / trade-off |
|---|---|
| Node 24 native type stripping (`erasableSyntaxOnly`, `.ts` import specifiers); `tsc` only for `dist/` | No transpiler in dev or tests; child-process tests run the real entry points. Costs: no enums/parameter properties |
| Own ~50-line SQL migration runner | The SQL files are the reviewable truth; no ORM or migration DSL between reader and constraints |
| Defence in depth inside PostgreSQL: unique phase index, settle/release partial unique index, deferred balance trigger, immutability triggers, terminal-state trigger, nonnegative `CHECK`, least-privilege roles | Invariants hold even if application code is wrong; tests attack the database directly |
| Concurrency resolved by the idempotency primary key (`INSERT … ON CONFLICT DO NOTHING`), then a per-account `FOR NO KEY UPDATE` lock | Losers block on the winner and replay without a second balance check. `FOR UPDATE` deadlocked against FK `KEY SHARE` locks (found by the S4 race test) |
| One function (`applyProviderEvidence`) handles submit responses, lookups and webhooks | One place decides settle/release/ignore/exception; business-level dedup works across channels and event IDs |
| Inbox processing claims, applies and marks in **one** transaction (row lock, `SKIP LOCKED`) instead of leasing | No provider I/O happens there, so a lease adds nothing; crash-before-commit redoes, crash-after-commit finds the marker |
| Jobs use leases with an integer fencing token checked inside each writing transaction | A stale worker's result is recorded as evidence (`stale_worker_result_discarded`) but changes nothing |
| Recovery of persisted `submitting` always goes through `outcome_unknown` → lookup; *not found* → resubmit same reference | "Not found" is not rejection; never a fresh reference |
| Injected `Clock` and `IdGenerator`; scenarios use a manual clock and seeded IDs | Deterministic, comparable traces; timestamps in replays are ordering aids, not measurements |
| Fault injection = constructor-injected checkpoints (API/worker) and fault-plan **rows** in the provider DB written by the harness | No fault or reset HTTP routes exist anywhere; plans survive a simulator restart; production entry points cannot inject faults |
| Webhook dedup hashes the validated content in canonical order; signature covers the raw bytes | Whitespace cannot fake a conflict; signing time is transport-level and fresh per redelivery |
| Unknown outcomes and invariant failures in the exception listing are **derived views**; only conflicting observations are stored rows | They cannot drift from the state they describe |
| I6 reports `unknown` once any submission was sent | The application cannot count effects inside the provider; only the test oracle can |
| MCP: strict zod input objects, published output schemas, one `REPEATABLE READ READ ONLY` snapshot per call with its identity in the result, 256 KiB response cap, linked evidence only on the first page | Bounded, schema-validated, and honest about completeness |
| MCP output schemas avoid `"type": ["string", "null"]` and empty `{}` sub-schemas: nullable primitives are `anyOf` unions with a described branch each, trace `facts` and linked evidence are fully typed | MCP Inspector's portability check flagged 9 warnings on the first version: the array form of `type` is legal JSON Schema but some MCP clients reject or ignore it, and `{}` constrains nothing. The contract is unchanged (`null` still means null); `tests/mcp` now walks every published schema to keep it that way |
| Viewer in vanilla TypeScript with a text-node-only DOM helper (no `innerHTML`), bundled by Vite | Zero runtime dependencies; hostile strings cannot become markup by construction |
| Local demo credentials are obviously synthetic defaults in code and `.env.example` | A fresh clone runs without configuration; destructive commands refuse non-loopback hosts and non-`prl_demo_`/`prl_test_` database names |
| Live evaluation used `claude-sonnet-4-6` through the locally installed CLI 2.1.90 | That CLI was too old for the account's default model; recorded precisely in the run file |
| After the CLI was updated to 2.1.274, `evals/run-live.sh` lost its model argument and the `MCP_CONNECTION_NONBLOCKING=false` workaround | Three headless sessions showed the server connected with all three tools at init without the variable; one full S3 run with the default model (`claude-fable-5-1`) called only the three MCP tools and cited 24 IDs, all grounded |

## Progress log

### Milestone 1 — runnable foundation: done
Pinned dependencies and lockfile; strict TypeScript, ESLint, Prettier, Vitest projects; SQL
migrations for app and provider databases with separated roles; Testcontainers harness with a
fresh database pair per test file and a loud failure when Docker is missing; `docker-compose.yml`
for the local demo; guarded `db:migrate`, `demo:seed`, `demo:reset`. Evidence:
`tests/integration/foundation.test.ts`.

### Milestone 2 — transfer acceptance and journal: done
Exact amounts, scoped idempotency with economic fingerprint, atomic accept + reserve + trace +
job, account scoping, trace/evidence/invariant/balance/exception read endpoints, error
envelopes, body and pagination bounds. Evidence: `s1-acceptance.test.ts`, unit tests.

### Milestone 3 — external failures and recovery: done
Persistent idempotent provider simulator with harness-only fault plans and oracle; leased,
fenced worker with unknown-outcome recovery; signed webhook inbox with delivery- and
business-level dedup, ordering and contradiction handling; real process kill/restart tests.
Evidence: `s2-webhooks.test.ts`, `s3-unknown-outcome.test.ts`, `process-crash.test.ts`.

### Milestone 4 — MCP and reusable skill: done
Three read-only tools, schemas, scope, snapshot identity, bounded output, distinguishable
errors; DB-level denial tests; `.mcp.json`; `investigate-transfer` skill; rubric and runner; five
live Claude Code runs recorded with provenance. Evidence: `tests/mcp/mcp.test.ts`, `evals/`.

### Milestone 5 — viewer and replay: done
Lanes, causation links, broken-connector marker, balances, invariants with text + colour,
distinct UNKNOWN state, arrival-vs-provider-order table, filters, play/pause/step, keyboard and
reduced-motion support, live tab with explicit disconnect/stale states, labelled oracle box;
versioned replay export with provenance and `implementationRevision: "unavailable"`.
Evidence: `tests/e2e/viewer.spec.ts`; screenshots inspected.

### Milestone 6 — open-source readiness: done, except what needs the owner
README rewritten to match the implementation; CI workflow with SHA-pinned actions (verified with
`git ls-remote`), read-only permissions, no deployment; decisions, assumptions, mapping and
verification documented; files reviewed for secrets and private content (only synthetic demo
defaults exist). At the end of the implementation session everything was left uncommitted for owner review.

### After owner review — 17 September 2026
The owner asked for the initial commit (`304b25b`, author Fran Ros) and pushed it to
`fjros/payment-reliability-lab`; the first CI run completed with `success`. The repository uses a
repo-local `core.sshCommand` to select the owner's GitHub key. Still open: the public replays say
`implementationRevision: "unavailable"` because they predate the first commit; regenerate them
with `npm run demo:export -- all --out=web/public/replays` if a real hash is wanted.

Known limitations are listed in the README. Next useful steps, none started: capped backoff and
a dead-letter policy for long-pending transfers; surfacing uncorrelated webhooks; repeated
live-agent trials across models; an illustrative "naive design" comparison in the viewer.

## Continuing this log

For each milestone record: actual files/features added, decisions that changed, commands executed with results, known limitations and the next step. Never replace a failure with “verified” unless rerun evidence exists. For an architecture change, explain which invariant remains protected and how the tests demonstrate it.


### Application showcase — 17 September 2026

Added a separate public build mode and manual GitHub Pages workflow. It includes only the
static viewer, synthetic replay fixtures and reviewed media. The Live API tab is absent in
this build, including for stale `#live` bookmarks. Backend, database and raw agent sessions
remain local. This keeps the public demo usable without allocating a server or exposing
mutation endpoints. Existing local development and API investigation remain available.

Added public-browser checks for scenario navigation, unknown outcome, reserved funds, source
links, refresh and responsive layout. The accompanying captioned video shows S1–S3 and reviewed
output from an actual Claude Code investigation; it never presents recorded output as a live
agent invocation. Media provenance and reproduction notes are in `WALKTHROUGH.md`.
