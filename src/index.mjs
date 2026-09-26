import { createHash } from 'node:crypto';
import { validateDataset, validatePlan, DatasetEvidenceError, PlanConfigError } from './validate.mjs';

export const TOOL_ID = 'eval-dataset-sampler';
export const RULE_SEVERITY = Object.freeze({
  'invalid-dataset': 'error', 'no-candidates': 'error',
  'candidate-limit': 'error', 'holdout-limit': 'error',
  'invalid-candidate': 'error', 'duplicate-candidate': 'error',
  'invalid-holdout': 'error', 'duplicate-holdout': 'error',
  'unknown-stratum': 'error', 'holdout-id-collision': 'error',
  'holdout-source-collision': 'error', 'holdout-digest-collision': 'error',
  'sample-shortage': 'error', 'quota-shortage': 'error',
  'unreadable-dataset': 'error', 'parse-error': 'error', 'input-limit': 'error',
  'invalid-evidence': 'error', timeout: 'error', 'report-write-error': 'error',
});
const MESSAGE = Object.freeze({
  'invalid-dataset': 'Dataset structure is incomplete or unsupported.',
  'no-candidates': 'No candidate evidence was supplied.',
  'candidate-limit': 'Candidate count exceeds the configured limit.',
  'holdout-limit': 'Holdout count exceeds the configured limit.',
  'invalid-candidate': 'Candidate metadata is incomplete or unsupported.',
  'duplicate-candidate': 'Candidate identity or digest is ambiguous.',
  'invalid-holdout': 'Holdout metadata is incomplete or unsupported.',
  'duplicate-holdout': 'Holdout identity or digest is ambiguous.',
  'unknown-stratum': 'A stratum is not matched by an explicit target.',
  'holdout-id-collision': 'A candidate ID is held out.',
  'holdout-source-collision': 'A candidate source is held out.',
  'holdout-digest-collision': 'Candidate content is held out.',
  'sample-shortage': 'Too few candidates exist for the requested sample size.',
  'quota-shortage': 'A stratum has fewer candidates than its minimum.',
  'unreadable-dataset': 'Named dataset could not be read within the root.',
  'parse-error': 'Named dataset is malformed or ambiguous JSON.',
  'input-limit': 'Named dataset exceeds an evidence limit.',
  'invalid-evidence': 'Named dataset contains unsupported evidence.',
  timeout: 'Sampling exceeded its time limit.',
  'report-write-error': 'The named report destination could not be written safely.',
});
const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new PlanConfigError('invalid-options');
  for (const key of Object.keys(options)) {
    if (!['maxCandidates', 'maxHoldout', 'timeoutMs', 'now', 'datasetFile', 'planFile'].includes(key)) throw new PlanConfigError('unknown-option');
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new PlanConfigError('invalid-clock');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)) throw new PlanConfigError('invalid-timeout');
  for (const key of ['datasetFile', 'planFile']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length < 1 || options[key].length > 256 || options[key].startsWith('/') || options[key].split(/[\\/]/u).includes('..') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(options[key]))) throw new PlanConfigError('invalid-file-label');
  }
}

function makeFinding(ruleId, file, pointer) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('unknown-rule');
  const location = { file };
  if (pointer !== undefined) location.pointer = pointer;
  return { ruleId, severity: RULE_SEVERITY[ruleId], message: MESSAGE[ruleId], location };
}

function envelope(status, dataset, rawFindings = [], sample = []) {
  const findings = rawFindings.map(({ ruleId, file, pointer }) => makeFinding(ruleId, file, pointer));
  findings.sort((a, b) => compare(a.location.file, b.location.file) || compare(a.location.pointer ?? '', b.location.pointer ?? '') || compare(a.ruleId, b.ruleId));
  return {
    schemaVersion: '1', tool: TOOL_ID, status,
    summary: {
      checked: status === 'incomplete' ? 0 : Array.isArray(dataset?.candidates) ? dataset.candidates.length : 0,
      errors: findings.filter((entry) => entry.severity === 'error').length,
      warnings: findings.filter((entry) => entry.severity === 'warning').length,
      candidates: Array.isArray(dataset?.candidates) ? dataset.candidates.length : 0,
      holdout: Array.isArray(dataset?.holdout) ? dataset.holdout.length : 0,
      selected: sample.length,
    },
    findings, sample,
  };
}

export function sampleDataset(dataset, plan, options = {}) {
  validateOptions(options);
  const datasetFile = options.datasetFile ?? 'dataset.json';
  const planFile = options.planFile ?? 'plan.json';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const start = now();
  if (!Number.isFinite(start)) throw new PlanConfigError('invalid-clock');
  const timedOut = () => {
    const current = now();
    if (!Number.isFinite(current) || current < start) throw new PlanConfigError('invalid-clock');
    return current - start > timeoutMs;
  };
  const one = (status, ruleId, file = datasetFile, pointer) => envelope(status, dataset, [{ ruleId, file, pointer }]);
  const validatedPlan = validatePlan(plan);
  if (timedOut()) return one('incomplete', 'timeout');
  let validated;
  try {
    validated = validateDataset(dataset, { maxCandidates: options.maxCandidates, maxHoldout: options.maxHoldout });
  } catch (error) {
    if (error instanceof DatasetEvidenceError) {
      const pointer = error.index === null ? undefined : `/${error.code.includes('holdout') ? 'holdout' : 'candidates'}/${error.index}`;
      return one('incomplete', error.code, datasetFile, pointer);
    }
    throw error;
  }
  if (timedOut()) return one('incomplete', 'timeout');
  const heldIds = new Set(validated.holdout.map((entry) => entry.id));
  const heldSources = new Set(validated.holdout.map((entry) => entry.sourceId));
  const heldDigests = new Set(validated.holdout.map((entry) => entry.contentSha256));
  let collision;
  for (let i = 0; i < validated.candidates.length; i += 1) {
    const entry = validated.candidates[i];
    const pointer = `/candidates/${i}`;
    if (heldIds.has(entry.id)) collision = { ruleId: 'holdout-id-collision', pointer };
    else if (heldSources.has(entry.sourceId)) collision = { ruleId: 'holdout-source-collision', pointer };
    else if (heldDigests.has(entry.contentSha256)) collision = { ruleId: 'holdout-digest-collision', pointer };
    if (collision) break;
  }
  if (timedOut()) return one('incomplete', 'timeout');
  const groups = new Map();
  for (const entry of validated.candidates) {
    if (!groups.has(entry.stratumKey)) groups.set(entry.stratumKey, []);
    groups.get(entry.stratumKey).push(entry);
  }
  const targets = new Map(validatedPlan.targets.map((entry) => [entry.stratumKey, entry]));
  for (const key of [...groups.keys()].sort(compare)) if (!targets.has(key)) return one('incomplete', 'unknown-stratum');
  for (const key of [...targets.keys()].sort(compare)) if (!groups.has(key)) return one('incomplete', 'unknown-stratum', planFile);
  if (timedOut()) return one('incomplete', 'timeout');
  if (collision) return one('fail', collision.ruleId, datasetFile, collision.pointer);
  if (validatedPlan.sampleSize > validated.candidates.length) return one('fail', 'sample-shortage', planFile);
  for (const key of [...targets.keys()].sort(compare)) if (targets.get(key).min > groups.get(key).length) return one('fail', 'quota-shortage', planFile);
  const rank = (entry) => createHash('sha256').update(JSON.stringify([validatedPlan.seed, entry.id, entry.sourceId, entry.contentSha256])).digest('hex');
  const byRank = (a, b) => compare(a.rank, b.rank) || compare(a.id, b.id);
  const ranked = validated.candidates.map((entry) => ({ ...entry, rank: rank(entry) }));
  const selectedIds = new Set();
  for (const key of [...targets.keys()].sort(compare)) {
    const entries = ranked.filter((entry) => entry.stratumKey === key).sort(byRank);
    for (const entry of entries.slice(0, targets.get(key).min)) selectedIds.add(entry.id);
  }
  for (const entry of [...ranked].sort(byRank)) {
    if (selectedIds.size >= validatedPlan.sampleSize) break;
    selectedIds.add(entry.id);
  }
  if (timedOut()) return one('incomplete', 'timeout');
  const sample = ranked.filter((entry) => selectedIds.has(entry.id)).map(({ id, sourceId }) => ({ id, sourceId }));
  sample.sort((a, b) => compare(a.id, b.id) || compare(a.sourceId, b.sourceId));
  return envelope('pass', dataset, [], sample);
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0;
  if (report.status === 'fail') return 1;
  return 2;
}

export function incompleteDatasetReport(ruleId, file = 'dataset.json') {
  if (!['unreadable-dataset', 'parse-error', 'input-limit', 'invalid-evidence', 'timeout'].includes(ruleId)) throw new PlanConfigError('invalid-incomplete-rule');
  return envelope('incomplete', null, [{ ruleId, file }]);
}

export function reportWriteFailure() {
  return envelope('incomplete', null, [{ ruleId: 'report-write-error', file: '(report)' }]);
}
