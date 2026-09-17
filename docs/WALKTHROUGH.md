# Public walkthrough provenance

The video shows the static viewer of the committed synthetic replay fixtures for S1, S2 and
S3, followed by reviewed excerpts from a separate real Claude Code investigation on
17 September 2026. It is a screen recording with open captions, an optional WebVTT track and
an HTML text transcript. No audio is required. The public replay does not run a backend or
an agent.

## Agent segment

The local S3 scenario was stopped while the application knew only `outcome_unknown`. Claude
Code was invoked with the repository's `/investigate-transfer` skill and the three read-only
MCP tools. It called `get_transfer_trace`, `check_invariants` and `list_exceptions`. The
reviewed report cited 15 distinct evidence IDs, all present in the tool output, and retained
`unknown` for the external outcome. There were no mutating tool calls. This is one observed
run, not a reliability estimate for the model.

`web/public/media/agent-investigation.json` contains the reviewed final answer, tool inputs,
client/model versions, evidence counts and a SHA-256 digest identifying the private source transcript. The HTML page
shows excerpts and offers the complete answer. Raw session events, machine paths, account
metadata and credentials are excluded.

## Reproduce the investigation

Follow the README's local setup, then run:

```bash
npm run demo:scenario -- S3 --stop-at-unknown
npm run build:server
claude
```

Invoke `/investigate-transfer` with the transfer and run IDs printed by the scenario. A new
model invocation can produce different wording; compare its claims with the evidence, using
the evaluation rubric in `evals/`. The video itself is a fixed recording.
