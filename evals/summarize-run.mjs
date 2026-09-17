// Prints the reviewable facts of one stream-json run: model, tools offered, tools called, result.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8')
  .trim()
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
const result = lines.find((l) => l.type === 'result');
const calls = lines
  .filter((l) => l.type === 'assistant')
  .flatMap((l) => l.message.content.filter((c) => c.type === 'tool_use').map((c) => `${c.name} ${JSON.stringify(c.input)}`));
const errors = lines
  .filter((l) => l.type === 'user')
  .flatMap((l) =>
    (Array.isArray(l.message.content) ? l.message.content : [])
      .filter((c) => c.type === 'tool_result' && c.is_error)
      .map((c) => JSON.stringify(c.content).slice(0, 200)),
  );
console.log(`model: ${init?.model}\nclaude code: ${init?.claude_code_version}\ntools offered: ${JSON.stringify(init?.tools)}`);
console.log(`tool calls (${calls.length}):\n  ${calls.join('\n  ')}`);
if (errors.length) console.log(`tool errors:\n  ${errors.join('\n  ')}`);
console.log(`turns: ${result?.num_turns}  cost_usd: ${result?.total_cost_usd}  is_error: ${result?.is_error}\n\n${result?.result}`);

// Grounding check: every evidence-shaped ID in the final answer must occur in some tool result.
const toolText = lines
  .filter((l) => l.type === 'user')
  .map((l) => JSON.stringify(l.message.content))
  .join('\n');
const cited = [...new Set((result?.result ?? '').match(/\b(?:ev|jb|jp|att|obs|evt|exc|dlv|tr|pref|req|job)_[0-9a-f]{20,32}\b/g) ?? [])];
const ungrounded = cited.filter((id) => !toolText.includes(id));
console.log(
  `\n--- grounding: ${cited.length} distinct IDs cited, ${ungrounded.length} not found in tool output${ungrounded.length ? `: ${ungrounded.join(', ')}` : ''}`,
);
const nonMcp = calls.filter(
  (c) => !c.startsWith('mcp__payment-reliability-lab__') && !c.startsWith('ToolSearch') && !c.startsWith('Skill'),
);
console.log(`--- non-MCP tool calls: ${nonMcp.length}${nonMcp.length ? `: ${nonMcp.join(' | ')}` : ''}`);
