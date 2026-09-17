import { SCENARIOS } from './answers.ts';
import { parseScenarioArgs, runLocalScenarios } from './local-lab.ts';
import { answerFor, answerInputsFrom } from './answers.ts';

const say = (text = ''): void => void process.stdout.write(`${text}\n`);

try {
  const args = parseScenarioArgs(process.argv.slice(2));
  const results = await runLocalScenarios(args.ids, args.seed, { stopAtUnknown: args.stopAtUnknown });
  for (const result of results) {
    const meta = SCENARIOS[result.scenarioId];
    const last = result.moments.at(-1)!;
    say(`\n=== ${result.scenarioId} — ${meta.title} (run ${result.runId}) ===`);
    say(meta.summary);
    for (const step of result.steps) say(`  ${String(step.n).padStart(2)}. [${step.actor}] ${step.text}`);
    say(`\n  Question : ${meta.question}`);
    say(`  Answer   : ${answerFor(result.scenarioId, answerInputsFrom(last, result.trace)).text}`);
    say(`  Transfer : ${result.transferId}   account: ${result.accountId}   state: ${last.transfer.state}`);
    say(
      `  Balances : available ${last.balances.availableMinor}, reserved ${last.balances.reservedMinor}, run clearing ${last.balances.runClearingMinor} (${last.balances.asset} minor units)`,
    );
    say(`  Invariants: ${last.invariants.results.map((r) => `${r.id}=${r.status}`).join(' ')}`);
    say(`  Trace    : ${result.trace.length} events; exceptions open: ${last.exceptions.length}`);
    say(`  [oracle, privileged] provider status: ${result.oracle.providerStatus}; external effects: ${result.oracle.providerEffectCount}`);
  }
  say('\nInspect: npm run dev (API on 127.0.0.1:4010), the viewer (npm run dev:web), or the MCP tools with the transfer ID above.');
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  if (/ECONNREFUSED|does not exist/.test(String((error as Error).message))) {
    process.stderr.write('Is the local demo database up and migrated? Run: npm run db:up && npm run db:migrate\n');
  }
  process.exit(1);
}
