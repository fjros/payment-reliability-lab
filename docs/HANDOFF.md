# First Claude Code session

> Status, 17 September 2026: this handoff has been executed. The implementation, its verification record and the remaining owner actions are described in [../README.md](../README.md), [DECISIONS.md](DECISIONS.md) and [VERIFICATION.md](VERIFICATION.md). The text below is kept as the original brief.

Use this prompt in Claude Code from the repository root:

> Read CLAUDE.md and the linked project specifications. Implement Payment Reliability Lab through the milestones in docs/IMPLEMENTATION_PLAN.md, using test-driven development and real PostgreSQL integration tests. Start by checking the local runtime and identifying any contradictions in the specifications, then build the first working slice and continue. Keep the three failure scenarios, exact money invariants, read-only MCP interface and evidence-based investigation skill as the core. Use only synthetic data. Update the README and decision log with actual progress and verification. Do not commit, push or deploy anything. Ask me only when a consequential ambiguity genuinely prevents progress.

## What you already have

The complete desired behavior, transaction boundaries, API baseline, failure scenarios, verification strategy, agent workflow, visual walkthrough and scope limits are in this repository. No prior chat or private attachment is necessary. `README.md` is the document index.

## What you must build

All runtime code, migrations, tests, simulator, fault harness, MCP server, reusable skill, viewer and example exports. Do not mistake specification prose for existing functionality. Select dependencies and produce a lockfile as part of the runnable foundation.

## Owner workflow

The public remote is intended to be `fjros/payment-reliability-lab`; it starts empty. Local files are intentionally uncommitted. Verify the remote instead of creating a second repository. Do not initialize a parent directory, touch another project or copy career preparation material into this one.

At the end, show the owner the commands to run the demo, test outcomes, the five-minute walkthrough and remaining limitations. Leave a cleanly reviewable uncommitted implementation. The owner will decide when to commit and publish.
