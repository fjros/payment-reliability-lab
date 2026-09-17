# Verification record

What was actually run, on what, and with which result. Rerun before relying on it; nothing here
is a promise about future states of the code.

## Environment of the recorded run (17 September 2026)

Linux 6.8 x86-64 · Node.js v24.11.0 · npm 11.13.0 · Docker 28.1.1 · PostgreSQL image
`postgres:17.11-alpine` · Playwright 1.63.0 (Chromium) · dependency versions pinned in
`package-lock.json`. Implementation revision: unavailable (zero commits at the time).

## Commands and results

Run from a clean `dist/`, in this order:

| Command | Result |
|---|---|
| `npm run typecheck` | 0 errors (server + tests, viewer, e2e configs) |
| `npm run lint` | ESLint clean; Prettier "All matched files use Prettier code style" |
| `npm run test:unit` | 7 files, **64 passed** |
| `npm run test:integration` | 6 files, **61 passed**, ~5 s, real PostgreSQL through Testcontainers |
| `npm run test:mcp` | 1 file, **12 passed** (11 in the first recorded run; a schema-portability test was added afterwards), real stdio transport against `dist/mcp/main.js` |
| `npm run build` | `dist/` server + `dist/web` static viewer |
| `npm run test:e2e` | **16 passed**, Chromium against the static build, no backend running |
| `DOCKER_HOST=tcp://127.0.0.1:1 npx vitest run --project integration` | **fails, exit 1**, with "Integration tests need a working Docker-compatible runtime … They are NOT skipped" |
| `npm run db:up && npm run db:migrate && npm run demo:seed && npm run demo:scenario -- all` | five scenarios printed; each final state and invariant line as documented in docs/DEMO.md |
| `npm run demo:scenario -- S2` twice | identical transfer ID and trace (seeded IDs + manual clock) |
| `npm run demo:export -- all --out=web/public/replays` | five replay files + `index.json`; `implementationRevision: "unavailable"` |
| `npm run dev` + `curl` POST as `demo-alice` | three processes; transfer settled via worker + auto-delivered webhooks; `I1..I8 = pass` except `I6 = unknown` |
| `evals/run-live.sh …` ×5 | real Claude Code sessions; see [evals/runs/2026-09-17-claude-code-live.md](../evals/runs/2026-09-17-claude-code-live.md) |

Mutation spot-check (done once by hand, then reverted): making `leaseStillHeld` always return
true failed 3 S3/S4 tests; removing the no-effect guard on rejection failed the state-machine
unit test. The suites do detect those regressions.

Two defects were found *by* the real-dependency tests during development and fixed:

1. A deadlock between concurrent acceptances: foreign-key inserts take `FOR KEY SHARE` on the
   account row while the balance check asked for `FOR UPDATE`. Fixed with `FOR NO KEY UPDATE`.
   Found by the distinct-key overspend race (S4). An in-memory fake would not have shown it.
2. `INSERT … ON CONFLICT DO UPDATE` on the balance projection evaluated the nonnegative `CHECK`
   against the bare delta. Replaced by UPDATE-then-INSERT with projection rows pre-created at seed.

Desktop (1440 px) and mobile (390 px) screenshots written by the e2e run to
`artifacts/local/screenshots/` were inspected by eye: four lanes with causation links on
desktop, single stacked column with lane chips on mobile, UNKNOWN styled as its own dashed amber
state rather than a red failure, broken-connector marker on the lost response.

## Scenario-to-test mapping

| Requirement | Tests |
|---|---|
| **S1** response really lost after commit; retry replays; one reservation | `tests/integration/s1-acceptance.test.ts` › "really loses the response after commit…" |
| S1 twenty concurrent identical requests converge | same file › "converges twenty concurrent identical requests…" |
| S1 same key, changed amount/destination → 409, nothing changed; note first-write-wins; account scoping; key not consumed by rejection | same file › conflict / note / scope / insufficient-funds tests |
| S1 restart variant (real `SIGKILL` of the API process, fresh process replays) | `tests/integration/process-crash.test.ts` › S1 |
| S1 worker completes: one settlement, one provider effect | `tests/integration/scenarios.test.ts` › S1 |
| **S2** redelivery ×3, second event ID for same outcome, older pending event; one settlement; evidence retained; arrival vs provider order | `tests/integration/s2-webhooks.test.ts` › first test |
| S2 inbox crash after commit / before commit; two workers racing on one inbox item | same file › three crash/race tests |
| S2 bad signature, expired signing time, unsigned, altered payload under same event ID, wrong correlation, unknown reference, contradictory rejection after settlement, payload bound | same file › remaining tests; `tests/unit/webhook-signature.test.ts` |
| **S3** response lost after provider commit; lookup unavailable; `outcome_unknown`; funds reserved; same reference; oracle says completed while the app says unknown | `tests/integration/s3-unknown-outcome.test.ts` › first test |
| S3 pending, explicit no-effect rejection (only case that releases), inconclusive lookup, deadline exceeded, crash before send (404 ≠ rejection, resubmit same reference), crash after provider answer, webhook overtakes delayed response, simulator restart keeps acceptance + idempotency by reference | same file |
| S3 restart variant (worker process exits at checkpoint; simulator killed and restarted; real worker recovers) | `tests/integration/process-crash.test.ts` › S3 |
| **S4** distinct keys cannot overspend | `s1-acceptance.test.ts` › S4 |
| S4 lease expiry + stale worker fenced; token fencing while job open; single lessee | `s3-unknown-outcome.test.ts` › S4 block |
| **S5** conservation: balanced batches, projection = journal, nonnegative, immutability, settle/release exclusion, after restarts | `tests/integration/foundation.test.ts`; `expectConservation` calls in S2/S3 tests; `tests/unit/journal.test.ts` |
| **S6** partial trace never presented as complete; pagination metadata | `tests/mcp/mcp.test.ts` › "S6: never presents a truncated trace as complete…"; HTTP pagination in `s1-acceptance.test.ts` |
| **S7** hostile note kept as untrusted data, no mutating tool, DB denies writes | `tests/mcp/mcp.test.ts` › S7 + read-only enforcement; `scenarios.test.ts` › S7; e2e "renders hostile note strings as text" |
| **S8** honest diagnosis inputs: duplicate delivery ≠ duplicate effect, unknown ≠ failure, contradiction not reconciled | `scenarios.test.ts` › S2/S3/S8 answers; `tests/unit/misc.test.ts` › answers; live rubric in `evals/` |
| Invariants I1–I8 incl. `unknown` for the external half of I6 | asserted in S1/S2/S3/S8 tests and MCP tests (I2 failure is provoked by corrupting a projection) |
| Amount/fingerprint/state-machine properties (generated sequences: terminal never regresses, ≤ 1 effect) | `tests/unit/*.test.ts` |
| Separate provider credentials; MCP role cannot write or read base tables; DB outage → explicit error | `foundation.test.ts` › credentials; `mcp.test.ts` › read-only enforcement |
| Viewer: scenario selection, inspection, keyboard, 390/768/1440, reduced motion, static load, text-only rendering, API disconnect/stale snapshot, direct refresh | `tests/e2e/viewer.spec.ts` |

## Not verified

CI: the first and so far only run, on the initial commit `304b25b` (17 September 2026), completed
with `success` (https://github.com/fjros/payment-reliability-lab/actions/runs/35204135449): typecheck, lint, unit, integration
(Testcontainers on the GitHub runner), MCP, build and Playwright. No load, soak, fuzz or long-running tests. No independent
database-server failure, disk-full or network-partition tests. Only Chromium was used for browser
tests. Accessibility was checked through roles, labels, focus and keyboard tests, not with an
automated audit tool or a screen reader.


## Public showcase verification — 17 September 2026

After adding the public build and replay-only navigation:

- `npm run typecheck` and `npm run lint`: passed.
- `npm run test:all`: 64 unit, 61 PostgreSQL integration, 12 MCP and 17 browser tests passed.
- `npm run test:public`: four browser tests passed (no live API tab or API requests, stale
  bookmark fallback, S3 unknown state and reserved funds, refresh, links, 390/768/1440 px).
- A real Claude Code investigation at S3's unknown checkpoint used all three MCP tools,
  cited 15 distinct evidence IDs present in their output, and did not use mutating tools.
  Only its reviewed answer and tool-call inputs are published; raw events stay private.

See `WALKTHROUGH.md` for the media provenance. The public site is an interactive replay of
exported runs; these checks do not claim a deployed backend or live public model execution.
