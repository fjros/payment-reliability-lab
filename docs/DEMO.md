# Visualization and reviewer walkthrough

The UI explains the system; it does not serve as evidence instead of working code. Implemented in `web/` (vanilla TypeScript + Vite); the optional "naive design" comparison was not built.

## Main view

A single transfer investigation screen with three switchable scenarios. Put the business question at the top: “Did the retry create another payment?”, “Did the duplicate notification change the balance?” or “Do we know whether this payment completed?” Show the answer only when supported by evidence, and label live observations versus exported replay.

Use parallel lanes for client/API, local database/journal, worker and provider observations. Connect related events with stable IDs and causation; distinguish a lost response with a broken connector. Include a compact balance panel showing available, reserved and settled/clearing units, with explicit `DEMO_USD` labels.

Clicking an event reveals its factual record and journal links. Filters can show requests, state changes, notifications and journal effects. Display arrival order and provider occurrence/sequence separately. Do not falsely imply one global causal clock from wall-clock timestamps alone.

Show the invariant results with pass/fail/unknown text as well as color. Uncertain outcomes use a distinct pending state, not a red failure. Repeated deliveries can be muted visually while remaining inspectable. Let reviewers compare a deliberately explained naive design with the actual protected trace only if the naive example is labeled illustrative rather than a second untested implementation.

Motion should clarify transitions and honor reduced-motion preferences. Provide play/pause/step controls for replays, accessible labels, visible focus, keyboard operation and mobile stacking. No autoplay video, decorative particle fields or scrolling that hides the evidence. A reviewer should grasp the first scenario in under one minute.

## Five-minute walkthrough

- 0:00–0:30: explain the synthetic scope and one-effect invariant.
- 0:30–1:30: S1; lose the response, retry and inspect identity plus the journal.
- 1:30–2:30: S2; show several notifications, one settlement and no state regression.
- 2:30–3:30: S3; show reserved funds and an unknown outcome, then reveal a later authoritative observation.
- 3:30–4:30: invoke the investigation skill through read-only MCP; require evidence IDs and correct uncertainty.
- 4:30–5:00: show relevant tests, fault checkpoints, assumptions and limitations.

## Five-minute walkthrough as implemented

Preparation (once): `npm ci && npm run db:up && npm run db:migrate && npm run build`.

- **0:00–0:30** — `npm run demo:scenario -- all`. Point at the banner facts: synthetic `DEMO_USD`, one journal effect per transfer, `[oracle, privileged]` line kept apart from what the application knows.
- **0:30–1:30 (S1)** — `npx vite preview --config web/vite.config.ts`, open `http://127.0.0.1:4173/#S1`. "Go to start", then step: request accepted → reserved → the red broken connector (response never arrived) → API restart → replay → conflicting retry. Read the answer line, open I1 and I3, click *funds reserved* to show the two postings summing to zero.
- **1:30–2:30 (S2)** — tab S2. Muted duplicate cards, the "arrival order vs provider order" table with the late older event highlighted, one `funds settled`, balances 98750 / 0 / 1250.
- **2:30–3:30 (S3)** — tab S3, drag the slider to event 9: amber "UNKNOWN — not a failure", reserved 1250, I6 unknown, I7 pass, open exception. Step to the end: lookup attempts with the same reference, then the authoritative observation and a single settlement. Open the oracle box last to show the application never guessed.
- **3:30–4:30 (agent)** — `npm run demo:scenario -- S3 --stop-at-unknown`, then in Claude Code `/investigate-transfer <transferId> S3-1` (or `evals/run-live.sh`). Expect the four sections, evidence IDs, "unknown", and no remediation. Try the S7 transfer to see the injected note quoted as untrusted and ignored.
- **4:30–5:00** — `npm run test:integration` (about five seconds, real PostgreSQL), then skim [VERIFICATION.md](VERIFICATION.md) and the README's guarantees and limitations.

## Export and sharing

Generate a versioned replay JSON from an actual deterministic scenario run. Include scenario ID, seed, observation time, implementation revision when available, invariant results and sufficient synthetic trace data. At zero commits, record revision as unavailable; never invent a hash. Mark provider-oracle evidence separately, and keep it out of an agent investigation supposed to lack it.

The static viewer must load the export with no backend, secret or agent subscription. Label recorded diagnoses and their provenance. Static replay is not live MCP execution. Keep local artifacts ignored; copy only reviewed synthetic examples into public artifacts deliberately.

Publishing the repo or a Pages replay is a separate owner action after implementation review. Do not alter a CV site from this repository. Produce a shareable demo link only after the user asks for deployment.
