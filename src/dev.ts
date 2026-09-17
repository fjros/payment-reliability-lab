import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Starts the API, the worker and the provider simulator as three real local processes. */
const entries = ['api/main', 'worker/main', 'provider-sim/main'];
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const children: ChildProcess[] = entries.map((entry) =>
  spawn(process.execPath, [fileURLToPath(new URL(`./${entry}.${extension}`, import.meta.url))], { stdio: 'inherit', env: process.env }),
);
let stopping = false;
const stopAll = (): void => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
};
for (const child of children) child.on('exit', stopAll);
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
