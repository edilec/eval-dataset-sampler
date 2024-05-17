#!/usr/bin/env node
import { checkSample } from '../src/check.mjs';
import { exitCodeFor } from '../src/index.mjs';

const flags = Object.freeze({
  '--root': 'root', '--dataset': 'dataset', '--plan': 'plan',
  '--max-bytes': 'maxBytes', '--max-nodes': 'maxNodes', '--max-depth': 'maxDepth',
  '--max-candidates': 'maxCandidates', '--max-holdout': 'maxHoldout',
  '--timeout-ms': 'timeoutMs',
});
const numeric = new Set(['maxBytes', 'maxNodes', 'maxDepth', 'maxCandidates', 'maxHoldout', 'timeoutMs']);

function parseArgs(args) {
  const options = { limits: {} };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') {
      if (seen.has(flag)) throw new Error('duplicate option');
      seen.add(flag);
      continue;
    }
    const key = flags[flag];
    if (!key || seen.has(flag) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('invalid option');
    seen.add(flag);
    const value = args[++i];
    if (numeric.has(key)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('invalid limit');
      options.limits[key] = Number(value);
    } else options[key] = value;
  }
  return options;
}

try {
  const report = await checkSample(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCodeFor(report);
} catch {
  process.stderr.write('Invalid configuration or execution failure.\n');
  process.exitCode = 2;
}
