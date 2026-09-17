import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseScenarioArgs, runLocalScenarios } from './local-lab.ts';
import { buildReplay, type ReplayDocument } from './replay.ts';

/**
 * Writes versioned replay JSON from an actual scenario run.
 *   default output: artifacts/local/ (git-ignored)
 *   --out=<dir>   : e.g. --out=web/public/replays to refresh the reviewed public examples
 */
try {
  const argv = process.argv.slice(2);
  const args = parseScenarioArgs(argv);
  const outDir = path.resolve(argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? 'artifacts/local');
  if (!outDir.startsWith(process.cwd())) throw new Error('--out must stay inside the repository');
  await mkdir(outDir, { recursive: true });
  const results = await runLocalScenarios(args.ids, args.seed);
  const generatedAt = new Date();
  for (const result of results) {
    const file = path.join(outDir, `${result.scenarioId}.replay.json`);
    await writeFile(file, `${JSON.stringify(buildReplay(result, args.seed, generatedAt), null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)} (${result.trace.length} trace events)\n`);
  }
  // The static viewer discovers replays through this index; it lists every replay in the folder.
  const replays = (await readdir(outDir)).filter((name) => name.endsWith('.replay.json')).sort();
  const index = [];
  for (const name of replays) {
    const doc = JSON.parse(await readFile(path.join(outDir, name), 'utf8')) as ReplayDocument;
    index.push({ id: doc.scenario.id, title: doc.scenario.title, file: name });
  }
  await writeFile(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
