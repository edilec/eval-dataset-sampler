import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleDataset, TOOL_ID, RULE_SEVERITY } from '../src/index.mjs';

const h = (c) => c.repeat(64);
const candidate = (id, overrides = {}) => ({
  id, sourceId: `src-${id}`, contentSha256: h(id[0].toLowerCase()), risk: 'low',
  category: 'qa', priorFailures: 0, coverageTag: 'general', ...overrides,
});
const target = (risk, category, priorFailureBand, coverageTag, min) => ({ risk, category, priorFailureBand, coverageTag, min });
const base = () => ({
  dataset: { schemaVersion: 1, candidates: [
    candidate('H', { contentSha256: h('a'), risk: 'high', category: 'safety', priorFailures: 3, coverageTag: 'rare' }),
    candidate('L1', { contentSha256: h('b') }),
    candidate('L2', { contentSha256: h('c') }),
  ], holdout: [] },
  plan: { schemaVersion: 1, seed: 'release-1', sampleSize: 2, targets: [
    target('high', 'safety', 'repeat', 'rare', 1),
    target('low', 'qa', 'none', 'general', 1),
  ] },
});

test('correct exact quotas pass and retain a rare high-risk case among competing candidates', () => {
  const { dataset, plan } = base();
  const report = sampleDataset(dataset, plan);
  assert.equal(report.tool, TOOL_ID);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.findings, []);
  assert.equal(report.sample.length, 2);
  assert.deepEqual(report.sample.map((entry) => entry.id), ['H', 'L2']);
  assert.ok(report.sample.some((entry) => entry.id === 'H' && entry.sourceId === 'src-H'));
  assert.equal(report.summary.selected, 2);
});

test('same seed and evidence reproduce sample IDs and code-unit output order', () => {
  const { dataset, plan } = base();
  const first = sampleDataset(dataset, plan);
  const second = sampleDataset(dataset, plan);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const ids = first.sample.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a === b ? 0 : a < b ? -1 : 1));
  const order = sampleDataset({ schemaVersion: 1, candidates: [candidate('aZ'), candidate('a_', { contentSha256: h('d') })], holdout: [] },
    { schemaVersion: 1, seed: 'release-1', sampleSize: 2, targets: [target('low', 'qa', 'none', 'general', 0)] });
  assert.deepEqual(order.sample.map((entry) => entry.id), ['aZ', 'a_']);
});

test('each holdout collision identity fails with no partial sample or leaked identifier', () => {
  for (const [field, ruleId] of [
    ['id', 'holdout-id-collision'], ['sourceId', 'holdout-source-collision'], ['contentSha256', 'holdout-digest-collision'],
  ]) {
    const { dataset, plan } = base();
    const held = { id: 'held-1', sourceId: 'src-held-1', contentSha256: h('f') };
    held[field] = dataset.candidates[0][field];
    dataset.holdout.push(held);
    const report = sampleDataset(dataset, plan);
    assert.equal(report.status, 'fail', field);
    assert.deepEqual(report.sample, [], field);
    assert.ok(report.findings.some((finding) => finding.ruleId === ruleId), field);
    assert.doesNotMatch(JSON.stringify(report.findings), /held-1|src-held-1|ffffffff/u);
  }
});

test('unconfigured or unobserved strata are incomplete, never silently sampled', () => {
  const { dataset, plan } = base();
  plan.targets.pop();
  const missing = sampleDataset(dataset, plan);
  assert.equal(missing.status, 'incomplete');
  assert.deepEqual(missing.sample, []);
  assert.equal(missing.findings[0].ruleId, 'unknown-stratum');
  const other = base();
  other.plan.targets.push(target('medium', 'ops', 'some', 'unseen', 0));
  assert.equal(sampleDataset(other.dataset, other.plan).status, 'incomplete');
});

test('quota exact N succeeds; N+1 shortage and sample-size shortage cannot pass', () => {
  const { dataset, plan } = base();
  assert.equal(sampleDataset(dataset, plan).status, 'pass');
  plan.targets[0].min = 2;
  plan.sampleSize = 3;
  const short = sampleDataset(dataset, plan);
  assert.equal(short.status, 'fail');
  assert.deepEqual(short.sample, []);
  assert.equal(short.findings[0].ruleId, 'quota-shortage');
  const different = base();
  different.plan.sampleSize = 4;
  assert.equal(sampleDataset(different.dataset, different.plan).findings[0].ruleId, 'sample-shortage');
});

test('an invalid holdout prevents a positive non-collision or quota-shortage claim', () => {
  const { dataset, plan } = base();
  dataset.holdout.push({ id: 'h-1', sourceId: 'src-h-1' });
  plan.targets[0].min = 2;
  plan.sampleSize = 3;
  const report = sampleDataset(dataset, plan);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.sample, []);
  assert.equal(report.findings[0].ruleId, 'invalid-holdout');
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'quota-shortage'));
});

test('unknown stratum outranks an independently known holdout collision', () => {
  const { dataset, plan } = base();
  plan.targets.pop();
  dataset.holdout.push({ id: 'H', sourceId: 'other-source', contentSha256: h('f') });
  const report = sampleDataset(dataset, plan);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.sample, []);
  assert.ok(report.findings.some((finding) => finding.ruleId === 'unknown-stratum'));
});

test('severity catalog matches documentation, and elapsed timeout uses injected clock', async () => {
  const expectedRules = [
    'invalid-dataset', 'no-candidates', 'candidate-limit', 'holdout-limit',
    'invalid-candidate', 'duplicate-candidate', 'invalid-holdout', 'duplicate-holdout',
    'unknown-stratum', 'holdout-id-collision', 'holdout-source-collision', 'holdout-digest-collision',
    'sample-shortage', 'quota-shortage', 'unreadable-dataset', 'parse-error', 'input-limit',
    'invalid-evidence', 'timeout', 'report-write-error',
  ];
  assert.deepEqual(Object.keys(RULE_SEVERITY).sort(), [...expectedRules].sort());
  assert.ok(Object.values(RULE_SEVERITY).every((severity) => severity === 'error'));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const table = readme.split('## Rules, status, and exits')[1].split('The report uses')[0];
  const documented = [...table.matchAll(/`([a-z][a-z-]*)`/gu)].map((match) => match[1]);
  assert.deepEqual(documented.sort(), [...expectedRules].sort());
  const { dataset, plan } = base();
  const onBoundary = sampleDataset(dataset, plan, { timeoutMs: 10, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 10; })() });
  assert.equal(onBoundary.status, 'pass');
  const over = sampleDataset(dataset, plan, { timeoutMs: 10, now: (() => { let n = 0; return () => n++ === 0 ? 0 : 11; })() });
  assert.equal(over.status, 'incomplete');
  assert.equal(over.findings[0].ruleId, 'timeout');
});
