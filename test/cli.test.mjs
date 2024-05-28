import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkSample, SamplerConfigError } from '../src/check.mjs';

const bin = fileURLToPath(new URL('../bin/eval-dataset-sampler.mjs', import.meta.url));
const hash = (c) => c.repeat(64);
const candidate = (id, digest, risk = 'low', category = 'qa', priorFailures = 0, coverageTag = 'general') => ({ id, sourceId: `src-${id}`, contentSha256: hash(digest), risk, category, priorFailures, coverageTag });
const dataset = () => ({ schemaVersion: 1, candidates: [candidate('H', 'a', 'high', 'safety', 3, 'rare'), candidate('L', 'b')], holdout: [] });
const plan = () => ({ schemaVersion: 1, seed: 'release-1', sampleSize: 2, targets: [
  { risk: 'high', category: 'safety', priorFailureBand: 'repeat', coverageTag: 'rare', min: 1 },
  { risk: 'low', category: 'qa', priorFailureBand: 'none', coverageTag: 'general', min: 1 },
] });
async function fixture(data = dataset(), policy = plan()) {
  const root = await mkdtemp(join(tmpdir(), 'edilec-sampler-cli-'));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(data));
  await writeFile(join(root, 'plan.json'), JSON.stringify(policy));
  return root;
}
const run = (root, extra = []) => spawnSync(process.execPath, [bin, '--root', root, '--dataset', 'dataset.json', '--plan', 'plan.json', ...extra], { encoding: 'utf8' });

test('correct saved dataset passes and reproduces the same selected IDs', async () => {
  const root = await fixture();
  const first = run(root);
  const second = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.sample.map((entry) => entry.id), ['H', 'L']);
  assert.equal(await readFile(join(root, 'dataset.json'), 'utf8'), JSON.stringify(dataset()));
});

test('CLI help and fixed human summary accompany default JSON, while --json is quiet', async () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: eval-dataset-sampler /u);
  assert.match(help.stdout, /--dataset FILE/u);
  assert.equal(help.stderr, '');
  const root = await fixture();
  const good = run(root);
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).status, 'pass');
  assert.equal(good.stderr, 'Evaluation dataset sampler: PASS; 0 findings.\n');
  const quiet = run(root, ['--json']);
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, good.stdout);
  assert.equal(quiet.stderr, '');
  const leaking = dataset();
  leaking.holdout.push({ id: 'held', sourceId: 'src-held', contentSha256: hash('a') });
  await writeFile(join(root, 'dataset.json'), JSON.stringify(leaking));
  const fail = run(root);
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).status, 'fail');
  assert.equal(fail.stderr, 'Evaluation dataset sampler: FAIL; 1 finding.\n');
  await writeFile(join(root, 'dataset.json'), '{"schemaVersion":');
  const incomplete = run(root);
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete');
  assert.equal(incomplete.stderr, 'Evaluation dataset sampler: INCOMPLETE; 1 finding.\n');
  const quietIncomplete = run(root, ['--json']);
  assert.equal(quietIncomplete.status, 2);
  assert.equal(quietIncomplete.stdout, incomplete.stdout);
  assert.equal(quietIncomplete.stderr, '');
  const invalid = run(root, ['--json', '--not-an-option']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'Invalid configuration or execution failure.\n');
});

test('a legal local filename containing two dots is not falsely refused', async () => {
  const root = await fixture();
  await writeFile(join(root, 'data..json'), JSON.stringify(dataset()));
  const result = spawnSync(process.execPath, [bin, '--root', root, '--dataset', 'data..json', '--plan', 'plan.json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

test('known holdout leakage fails; malformed or missing dataset is incomplete', async () => {
  const data = dataset();
  data.holdout.push({ id: 'held', sourceId: 'src-held', contentSha256: hash('a') });
  const root = await fixture(data);
  const leak = run(root);
  assert.equal(leak.status, 1);
  assert.equal(JSON.parse(leak.stdout).findings[0].ruleId, 'holdout-digest-collision');
  assert.deepEqual(JSON.parse(leak.stdout).sample, []);
  await writeFile(join(root, 'dataset.json'), '{"schemaVersion":');
  const malformed = run(root);
  assert.equal(malformed.status, 2);
  assert.equal(JSON.parse(malformed.stdout).status, 'incomplete');
  assert.equal(JSON.parse(malformed.stdout).findings[0].ruleId, 'parse-error');
  const missing = spawnSync(process.execPath, [bin, '--root', root, '--dataset', 'absent.json', '--plan', 'plan.json'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).findings[0].ruleId, 'unreadable-dataset');
});

test('invalid plan and unknown options are config errors with empty stdout', async () => {
  const badPlan = plan();
  badPlan.targets[0].min = 0;
  const root = await fixture(dataset(), badPlan);
  const invalid = run(root);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  const unknown = run(root, ['--not-a-real-option']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  await assert.rejects(checkSample({ root, dataset: 'dataset.json', plan: 'plan.json', limits: { maxRecord: 5 } }), SamplerConfigError);
});

test('duplicate JSON keys and escaping symlink never yield a sample', async () => {
  const root = await fixture();
  await writeFile(join(root, 'dataset.json'), `${JSON.stringify(dataset()).slice(0, -1)},"candidates":[]}`);
  const duplicate = run(root);
  assert.equal(duplicate.status, 2);
  assert.equal(JSON.parse(duplicate.stdout).status, 'incomplete');
  await writeFile(join(root, 'dataset.json'), JSON.stringify(dataset()));
  const outside = await mkdtemp(join(tmpdir(), 'edilec-sampler-outside-'));
  await writeFile(join(outside, 'dataset.json'), JSON.stringify(dataset()));
  await symlink(join(outside, 'dataset.json'), join(root, 'escape.json'));
  const escaped = spawnSync(process.execPath, [bin, '--root', root, '--dataset', 'escape.json', '--plan', 'plan.json'], { encoding: 'utf8' });
  assert.equal(escaped.status, 2);
  assert.equal(JSON.parse(escaped.stdout).status, 'incomplete');
});

test('rounded numeric dataset evidence is incomplete and rounded plan numbers are invalid configuration', async () => {
  const data = dataset();
  const p = plan();
  p.targets[1].priorFailureBand = 'some';
  const root = await fixture(data, p);
  await writeFile(join(root, 'dataset.json'), JSON.stringify(data).replace('"priorFailures":0', '"priorFailures":0.999999999999999999999'));
  const rounded = run(root);
  assert.equal(rounded.status, 2);
  assert.equal(JSON.parse(rounded.stdout).status, 'incomplete');
  await writeFile(join(root, 'dataset.json'), JSON.stringify(data));
  const one = { schemaVersion: 1, candidates: [data.candidates[0]], holdout: [] };
  const onePlan = { schemaVersion: 1, seed: 'release-1', sampleSize: 1, targets: [p.targets[0]] };
  await writeFile(join(root, 'dataset.json'), JSON.stringify(one));
  await writeFile(join(root, 'plan.json'), JSON.stringify(onePlan).replace('"sampleSize":1', '"sampleSize":0.999999999999999999999'));
  const badPlan = run(root);
  assert.equal(badPlan.status, 2);
  assert.equal(badPlan.stdout, '');
});

test('large exact decimal cancellation is legal in dataset and plan at N bytes but N+1 is refused', async () => {
  const token = `1${'0'.repeat(1_000_000)}e-1000000`;
  const data = dataset();
  const p = plan();
  p.targets[1].priorFailureBand = 'some';
  const root = await fixture(data, p);
  const datasetText = JSON.stringify(data).replace('"priorFailures":0', `"priorFailures":${token}`);
  await writeFile(join(root, 'dataset.json'), datasetText);
  const exactDataset = run(root, ['--max-bytes', String(Buffer.byteLength(datasetText))]);
  assert.equal(exactDataset.status, 0, exactDataset.stderr);
  assert.equal(JSON.parse(exactDataset.stdout).status, 'pass');
  await writeFile(join(root, 'dataset.json'), `${datasetText} `);
  const overDataset = run(root, ['--max-bytes', String(Buffer.byteLength(datasetText))]);
  assert.equal(overDataset.status, 2);
  assert.equal(JSON.parse(overDataset.stdout).findings[0].ruleId, 'input-limit');

  const one = { schemaVersion: 1, candidates: [data.candidates[0]], holdout: [] };
  const onePlan = { schemaVersion: 1, seed: 'release-1', sampleSize: 1, targets: [plan().targets[0]] };
  await writeFile(join(root, 'dataset.json'), JSON.stringify(one));
  const planText = JSON.stringify(onePlan).replace('"sampleSize":1', `"sampleSize":${token}`);
  await writeFile(join(root, 'plan.json'), planText);
  const exactPlan = run(root, ['--max-bytes', String(Buffer.byteLength(planText))]);
  assert.equal(exactPlan.status, 0, exactPlan.stderr);
  assert.equal(JSON.parse(exactPlan.stdout).status, 'pass');
  await writeFile(join(root, 'plan.json'), `${planText} `);
  const overPlan = run(root, ['--max-bytes', String(Buffer.byteLength(planText))]);
  assert.equal(overPlan.status, 2);
  assert.equal(overPlan.stdout, '');
});

test('CLI limits accept exact N and mark N+1 incomplete', async () => {
  const root = await fixture();
  const bytes = Buffer.byteLength(JSON.stringify(dataset()));
  assert.equal(run(root, ['--max-bytes', String(bytes)]).status, 0);
  await writeFile(join(root, 'dataset.json'), `${JSON.stringify(dataset())} `);
  assert.equal(JSON.parse(run(root, ['--max-bytes', String(bytes)]).stdout).findings[0].ruleId, 'input-limit');
  await writeFile(join(root, 'dataset.json'), JSON.stringify(dataset()));
  assert.equal(run(root, ['--max-candidates', '2']).status, 0);
  assert.equal(JSON.parse(run(root, ['--max-candidates', '1']).stdout).status, 'incomplete');
  assert.equal(run(root, ['--max-holdout', '0']).status, 0);
  const withHoldout = dataset();
  withHoldout.holdout.push({ id: 'held', sourceId: 'src-held', contentSha256: hash('f') });
  await writeFile(join(root, 'dataset.json'), JSON.stringify(withHoldout));
  assert.equal(run(root, ['--max-holdout', '1']).status, 0);
  assert.equal(JSON.parse(run(root, ['--max-holdout', '0']).stdout).status, 'incomplete');
});

test('JSON node and depth bounds accept exact legal evidence and refuse the next level', async () => {
  const root = await fixture();
  const data = dataset();
  data.candidates.push(candidate('L2', 'c'));
  await writeFile(join(root, 'dataset.json'), JSON.stringify(data));
  const count = (value) => 1 + (Array.isArray(value) ? value.reduce((sum, child) => sum + count(child), 0) : value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + count(child), 0) : 0);
  const nodes = count(data);
  assert.ok(nodes > count(plan()));
  assert.equal(run(root, ['--max-nodes', String(nodes)]).status, 0);
  assert.equal(JSON.parse(run(root, ['--max-nodes', String(nodes - 1)]).stdout).findings[0].ruleId, 'input-limit');
  assert.equal(run(root, ['--max-depth', '3']).status, 0);
  data.candidates[0].unexpected = ['nested'];
  await writeFile(join(root, 'dataset.json'), JSON.stringify(data));
  assert.equal(JSON.parse(run(root, ['--max-depth', '3']).stdout).findings[0].ruleId, 'input-limit');
});

test('whole-run timeout permits exact boundary and refuses N+1 with an injected clock', async () => {
  const root = await fixture();
  const at = await checkSample({ root, dataset: 'dataset.json', plan: 'plan.json', limits: { timeoutMs: 10 }, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 10; })() });
  assert.equal(at.status, 'pass');
  const over = await checkSample({ root, dataset: 'dataset.json', plan: 'plan.json', limits: { timeoutMs: 10 }, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 11; })() });
  assert.equal(over.status, 'incomplete');
  assert.equal(over.findings[0].ruleId, 'timeout');
});

test('invalid holdout beats shortage even through CLI', async () => {
  const data = dataset();
  data.holdout.push({ id: 'held', sourceId: 'src-held' });
  const p = plan();
  p.targets[0].min = 2;
  p.sampleSize = 3;
  const root = await fixture(data, p);
  const result = run(root);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'invalid-holdout');
});
