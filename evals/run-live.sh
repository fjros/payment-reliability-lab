#!/usr/bin/env bash
# Runs ONE live Claude Code investigation, locked to the three read-only MCP tools, and writes the
# raw stream to artifacts/local/ (git-ignored). Uses YOUR Claude Code login, default model and billing.
#   usage: evals/run-live.sh <label> <transferId> <runId>
# Needs a current Claude Code. Version 2.1.90 started headless turns before --mcp-config tools were
# registered (workaround there: MCP_CONNECTION_NONBLOCKING=false); 2.1.274 does not.
set -euo pipefail
label="$1"; transfer="$2"; run="$3"
cd "$(dirname "$0")/.."
mkdir -p artifacts/local
mcp="mcp__payment-reliability-lab__"
claude -p "/investigate-transfer ${transfer} ${run}" \
  --strict-mcp-config --mcp-config .mcp.json \
  --allowedTools "${mcp}get_transfer_trace,${mcp}check_invariants,${mcp}list_exceptions" \
  --disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,Agent" \
  --permission-mode dontAsk --output-format stream-json --verbose \
  < /dev/null > "artifacts/local/agent-run-${label}.jsonl"
node evals/summarize-run.mjs "artifacts/local/agent-run-${label}.jsonl"
