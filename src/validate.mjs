export class DatasetEvidenceError extends Error {
  constructor(code, index = null) { super(code); this.name = 'DatasetEvidenceError'; this.code = code; this.index = index; }
}

export class PlanConfigError extends Error {
  constructor(code) { super(code); this.name = 'PlanConfigError'; this.code = code; }
}

const riskValues = new Set(['high', 'medium', 'low']);
const bands = new Set(['none', 'some', 'repeat']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaque = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const label = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function priorFailureBand(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new DatasetEvidenceError('invalid-prior-failures');
  return count === 0 ? 'none' : count <= 2 ? 'some' : 'repeat';
}

export function stratumKey(value) {
  return JSON.stringify([value.risk, value.category, value.priorFailureBand, value.coverageTag]);
}

function validateLimits(limits) {
  if (!isObject(limits) || Object.keys(limits).some((key) => !['maxCandidates', 'maxHoldout'].includes(key))) throw new PlanConfigError('invalid-limits');
  const chosen = { maxCandidates: limits.maxCandidates ?? 10_000, maxHoldout: limits.maxHoldout ?? 10_000 };
  for (const value of Object.values(chosen)) if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new PlanConfigError('invalid-limit');
  return chosen;
}

export function validateDataset(dataset, limits = {}) {
  const { maxCandidates, maxHoldout } = validateLimits(limits);
  if (!exactKeys(dataset, ['schemaVersion', 'candidates', 'holdout']) || dataset.schemaVersion !== 1 || !Array.isArray(dataset.candidates) || !Array.isArray(dataset.holdout)) {
    throw new DatasetEvidenceError('invalid-dataset');
  }
  if (dataset.candidates.length === 0) throw new DatasetEvidenceError('no-candidates');
  if (dataset.candidates.length > maxCandidates) throw new DatasetEvidenceError('candidate-limit');
  if (dataset.holdout.length > maxHoldout) throw new DatasetEvidenceError('holdout-limit');
  const candidateIds = new Set();
  const candidateDigests = new Set();
  const candidates = dataset.candidates.map((entry, index) => {
    if (!exactKeys(entry, ['id', 'sourceId', 'contentSha256', 'risk', 'category', 'priorFailures', 'coverageTag']) ||
        !opaque(entry.id) || !opaque(entry.sourceId) || !digest(entry.contentSha256) ||
        !riskValues.has(entry.risk) || !label(entry.category) || !label(entry.coverageTag) ||
        !Number.isSafeInteger(entry.priorFailures) || entry.priorFailures < 0) {
      throw new DatasetEvidenceError('invalid-candidate', index);
    }
    if (candidateIds.has(entry.id) || candidateDigests.has(entry.contentSha256)) throw new DatasetEvidenceError('duplicate-candidate', index);
    candidateIds.add(entry.id);
    candidateDigests.add(entry.contentSha256);
    const priorFailureBand = priorFailureBandFor(entry.priorFailures);
    return { ...entry, priorFailureBand, stratumKey: stratumKey({ ...entry, priorFailureBand }) };
  });
  const holdoutIds = new Set();
  const holdoutDigests = new Set();
  const holdout = dataset.holdout.map((entry, index) => {
    if (!exactKeys(entry, ['id', 'sourceId', 'contentSha256']) || !opaque(entry.id) || !opaque(entry.sourceId) || !digest(entry.contentSha256)) {
      throw new DatasetEvidenceError('invalid-holdout', index);
    }
    if (holdoutIds.has(entry.id) || holdoutDigests.has(entry.contentSha256)) throw new DatasetEvidenceError('duplicate-holdout', index);
    holdoutIds.add(entry.id);
    holdoutDigests.add(entry.contentSha256);
    return { ...entry };
  });
  return { candidates, holdout };
}

const priorFailureBandFor = (count) => count === 0 ? 'none' : count <= 2 ? 'some' : 'repeat';

export function validatePlan(plan) {
  if (!exactKeys(plan, ['schemaVersion', 'seed', 'sampleSize', 'targets']) || plan.schemaVersion !== 1 ||
      !opaque(plan.seed) || !Number.isSafeInteger(plan.sampleSize) || plan.sampleSize < 1 || plan.sampleSize > 1_000 ||
      !Array.isArray(plan.targets) || plan.targets.length < 1 || plan.targets.length > 1_000) {
    throw new PlanConfigError('invalid-plan');
  }
  const seen = new Set();
  let minima = 0;
  const targets = plan.targets.map((target) => {
    if (!exactKeys(target, ['risk', 'category', 'priorFailureBand', 'coverageTag', 'min']) ||
        !riskValues.has(target.risk) || !label(target.category) || !bands.has(target.priorFailureBand) || !label(target.coverageTag) ||
        !Number.isSafeInteger(target.min) || target.min < 0 || target.min > 1_000 || (target.risk === 'high' && target.min < 1)) {
      throw new PlanConfigError('invalid-target');
    }
    const key = stratumKey(target);
    if (seen.has(key)) throw new PlanConfigError('duplicate-target');
    seen.add(key);
    minima += target.min;
    return { ...target, stratumKey: key };
  });
  if (minima > plan.sampleSize) throw new PlanConfigError('minima-exceed-sample');
  return { seed: plan.seed, sampleSize: plan.sampleSize, targets };
}
