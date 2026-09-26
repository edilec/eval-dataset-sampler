#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkSample } from '../src/check.mjs';
import { exitCodeFor, reportWriteFailure } from '../src/index.mjs';
import { assertWritableDestination } from '../src/write-guard.mjs';

const flags = Object.freeze({
  '--root': 'root', '--dataset': 'dataset', '--plan': 'plan', '--report': 'report',
  '--max-bytes': 'maxBytes', '--max-nodes': 'maxNodes', '--max-depth': 'maxDepth',
  '--max-candidates': 'maxCandidates', '--max-holdout': 'maxHoldout',
  '--timeout-ms': 'timeoutMs',
});
const numeric = new Set(['maxBytes', 'maxNodes', 'maxDepth', 'maxCandidates', 'maxHoldout', 'timeoutMs']);
const help = `Usage: eval-dataset-sampler --root DIR --dataset FILE --plan FILE [options]

Read a saved evaluation dataset and plan; write a JSON report to stdout.
Options:
  --report FILE                Also write the JSON report to this path under root.
  --max-bytes N  --max-nodes N  --max-depth N  --max-candidates N
  --max-holdout N  --timeout-ms N
  --json                     Suppress the human summary on stderr.
  --help                     Show this help when used alone.
Exit codes: 0 pass, 1 fail, 2 incomplete evidence or invalid configuration.
`;

function parseArgs(args) {
  const options = { limits: {}, jsonOnly: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') {
      if (seen.has(flag)) throw new Error('duplicate option');
      seen.add(flag);
      options.jsonOnly = true;
      continue;
    }
    const key = flags[flag];
    if (!key || seen.has(flag) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('invalid option');
    seen.add(flag);
    const value = args[++i];
    if (key === 'report' && value.length === 0) throw new Error('invalid report path');
    if (numeric.has(key)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('invalid limit');
      options.limits[key] = Number(value);
    } else options[key] = value;
  }
  return options;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help);
  } else {
    const { jsonOnly, report: reportPath, ...options } = parseArgs(args);
    let report = await checkSample(options);
    if (reportPath !== undefined) {
      const root = resolve(options.root);
      const inputs = [options.dataset, options.plan].map((path) => resolve(root, path));
      try {
        const destination = await assertWritableDestination(resolve(root, reportPath), { root, inputs, label: '--report' });
        await writeFile(destination, `${JSON.stringify(report)}\n`, 'utf8');
      } catch {
        report = reportWriteFailure();
      }
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!jsonOnly) {
      const count = report.findings.length;
      const status = { pass: 'PASS', fail: 'FAIL', incomplete: 'INCOMPLETE' }[report.status];
      process.stderr.write(`Evaluation dataset sampler: ${status}; ${count} finding${count === 1 ? '' : 's'}.\n`);
    }
    process.exitCode = exitCodeFor(report);
  }
} catch {
  process.stderr.write('Invalid configuration or execution failure.\n');
  process.exitCode = 2;
}
