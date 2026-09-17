import { execFileSync } from 'node:child_process';
import { answerFor, answerInputsFrom, SCENARIOS, type Answer } from './answers.ts';
import type { Moment, ScenarioResult } from './scenarios.ts';

export const REPLAY_FORMAT = 'payment-reliability-lab/replay';
export const REPLAY_VERSION = 1;

export interface ReplayDocument {
  format: typeof REPLAY_FORMAT;
  version: typeof REPLAY_VERSION;
  scenario: { id: string; title: string; question: string; summary: string };
  seed: string;
  runId: string;
  accountId: string;
  transferId: string;
  /** Wall-clock time the export was generated. Timestamps INSIDE the run come from a manual clock. */
  generatedAt: string;
  scenarioClock: string;
  /** Git commit of the implementation, or the literal "unavailable". Never invented. */
  implementationRevision: string;
  provenance: { kind: 'recorded-deterministic-scenario-run'; synthetic: true; generator: string; note: string };
  steps: ScenarioResult['steps'];
  trace: ScenarioResult['trace'];
  moments: Array<Moment & { answer: Answer }>;
  oracle: ScenarioResult['oracle'] & { privileged: true; notice: string };
  /** Present only if a REAL agent session was recorded; this export command never writes one. */
  agentDiagnosis: null | { provenance: string; model: string; recordedAt: string; text: string };
}

export function implementationRevision(): string {
  try {
    const hash = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[0-9a-f]{40}$/.test(hash)) return 'unavailable';
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
    return dirty ? `${hash}+uncommitted-changes` : hash;
  } catch {
    return 'unavailable'; // e.g. zero commits
  }
}

export function buildReplay(
  result: ScenarioResult,
  seed: string,
  generatedAt: Date,
  revision: string = implementationRevision(),
): ReplayDocument {
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    scenario: { id: result.scenarioId, ...SCENARIOS[result.scenarioId] },
    seed,
    runId: result.runId,
    accountId: result.accountId,
    transferId: result.transferId,
    generatedAt: generatedAt.toISOString(),
    scenarioClock:
      'Deterministic manual clock starting 2026-01-01T00:00:00.000Z; timestamps order events but are not wall-clock measurements.',
    implementationRevision: revision,
    provenance: {
      kind: 'recorded-deterministic-scenario-run',
      synthetic: true,
      generator: `npm run demo:export -- ${result.scenarioId}`,
      note: 'Recorded from a real local run (real PostgreSQL, real HTTP between API, worker and provider simulator). All accounts, funds and providers are synthetic. This is a static replay, not live MCP or agent execution.',
    },
    steps: result.steps,
    trace: result.trace,
    moments: result.moments.map((moment) => ({ ...moment, answer: answerFor(result.scenarioId, answerInputsFrom(moment, result.trace)) })),
    oracle: {
      privileged: true,
      notice:
        'Simulator ground truth read by the test harness. The application and the investigating agent never see this; it is shown only so a reviewer can check that the application did not guess.',
      ...result.oracle,
    },
    agentDiagnosis: null,
  };
}
