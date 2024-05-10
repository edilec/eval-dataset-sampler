import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset, validatePlan, DatasetEvidenceError, PlanConfigError, priorFailureBand, stratumKey } from '../src/validate.mjs';

const hash = (character) => character.repeat(64);
const candidate = (id = 'c-1', overrides = {}) => ({
  id, sourceId: `src-${id}`, contentSha256: hash('a'), risk: 'high',
  category: 'safety', priorFailures: 3, coverageTag: 'refusal', ...overrides,
});
const target = (overrides = {}) => ({ risk: 'high', category: 'safety', priorFailureBand: 'repeat', coverageTag: 'refusal', min: 1, ...overrides });

test('correct dataset and plan are accepted with exact stratum identity', () => {
  const data = validateDataset({ schemaVersion: 1, candidates: [candidate()], holdout: [] });
  const plan = validatePlan({ schemaVersion: 1, seed: 'release-1', sampleSize: 1, targets: [target()] });
  assert.equal(data.candidates[0].stratumKey, stratumKey(target()));
  assert.equal(plan.targets[0].stratumKey, data.candidates[0].stratumKey);
  assert.equal(priorFailureBand(0), 'none');
  assert.equal(priorFailureBand(2), 'some');
  assert.equal(priorFailureBand(3), 'repeat');
});

test('malformed or ambiguous candidate and holdout evidence is incomplete, not usable', () => {
  const base = { schemaVersion: 1, candidates: [candidate()], holdout: [] };
  assert.throws(() => validateDataset({ ...base, candidates: [] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, candidates: [candidate(), candidate('c-2', { contentSha256: hash('a') })] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, candidates: [candidate(), candidate('c-1', { contentSha256: hash('b') })] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, candidates: [candidate('c-1', { risk: 'unknown' })] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, holdout: [{ id: 'h-1', sourceId: 'src-h-1' }] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, holdout: [
    { id: 'h-1', sourceId: 'src-h-1', contentSha256: hash('b') },
    { id: 'h-1', sourceId: 'src-h-2', contentSha256: hash('c') },
  ] }), DatasetEvidenceError);
  assert.throws(() => validateDataset({ ...base, holdout: [
    { id: 'h-1', sourceId: 'src-h-1', contentSha256: hash('b') },
    { id: 'h-2', sourceId: 'src-h-2', contentSha256: hash('b') },
  ] }), DatasetEvidenceError);
});

test('record limits accept N and refuse N+1 on both candidate and holdout sides', () => {
  const base = { schemaVersion: 1, candidates: [candidate()], holdout: [{ id: 'h-1', sourceId: 'src-h-1', contentSha256: hash('b') }] };
  assert.equal(validateDataset(base, { maxCandidates: 1, maxHoldout: 1 }).holdout.length, 1);
  assert.throws(() => validateDataset(base, { maxCandidates: 0, maxHoldout: 1 }), DatasetEvidenceError);
  assert.throws(() => validateDataset(base, { maxCandidates: 1, maxHoldout: 0 }), DatasetEvidenceError);
});

test('invalid plan keys, duplicate targets and contradictory minima are configuration errors', () => {
  const base = { schemaVersion: 1, seed: 'release-1', sampleSize: 1, targets: [target()] };
  assert.throws(() => validatePlan({ ...base, randomized: true }), PlanConfigError);
  assert.throws(() => validatePlan({ ...base, seed: '' }), PlanConfigError);
  assert.throws(() => validatePlan({ ...base, targets: [target(), target()] }), PlanConfigError);
  assert.throws(() => validatePlan({ ...base, targets: [target({ min: 0 })] }), PlanConfigError);
  assert.throws(() => validatePlan({ ...base, targets: [target({ min: 2 })] }), PlanConfigError);
  assert.throws(() => validatePlan({ ...base, sampleSize: 1001 }), PlanConfigError);
  assert.equal(validatePlan({ ...base, sampleSize: 1000 }).sampleSize, 1000);
  assert.throws(() => validatePlan({ ...base, targets: Array.from({ length: 1001 }, (_, i) => target({ category: `c${i}`, risk: 'low', min: 0 })) }), PlanConfigError);
});
