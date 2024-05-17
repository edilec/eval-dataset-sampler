import { relative, resolve, isAbsolute } from 'node:path';
import { readBoundedJson, JsonEvidenceError } from './json.mjs';
import { sampleDataset, incompleteDatasetReport } from './index.mjs';
import { validatePlan, PlanConfigError } from './validate.mjs';

export class SamplerConfigError extends Error {
  constructor(code) { super(code); this.name = 'SamplerConfigError'; this.code = code; }
}

const defaultLimits = Object.freeze({
  maxBytes: 1_048_576, maxNodes: 100_000, maxDepth: 16,
  maxCandidates: 10_000, maxHoldout: 10_000, timeoutMs: 30_000,
});

function checkOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new SamplerConfigError('invalid-options');
  for (const key of Object.keys(options)) if (!['root', 'dataset', 'plan', 'limits', 'now'].includes(key)) throw new SamplerConfigError('unknown-option');
  for (const key of ['root', 'dataset', 'plan']) if (typeof options[key] !== 'string' || options[key].length < 1) throw new SamplerConfigError('missing-option');
  if (options.now !== undefined && typeof options.now !== 'function') throw new SamplerConfigError('invalid-clock');
  const provided = options.limits ?? {};
  if (provided === null || typeof provided !== 'object' || Array.isArray(provided)) throw new SamplerConfigError('invalid-limits');
  for (const key of Object.keys(provided)) if (!Object.hasOwn(defaultLimits, key)) throw new SamplerConfigError('unknown-limit');
  const limits = { ...defaultLimits, ...provided };
  for (const [key, value] of Object.entries(limits)) {
    const min = ['maxHoldout', 'maxCandidates', 'maxDepth', 'timeoutMs'].includes(key) ? 0 : 1;
    const max = ['maxHoldout', 'maxCandidates'].includes(key) ? 10_000 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new SamplerConfigError('invalid-limit');
  }
  return limits;
}

function safeFile(root, path) {
  const name = relative(resolve(root), resolve(root, path));
  if (!name || name === '..' || name.startsWith('../') || isAbsolute(name) || name.length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return '(outside-root)';
  return name;
}

function datasetRule(code) {
  if (['duplicate-key', 'malformed-json'].includes(code)) return 'parse-error';
  if (['byte-limit', 'depth-limit', 'node-limit'].includes(code)) return 'input-limit';
  if (['unreadable', 'outside-root', 'not-file', 'invalid-utf8'].includes(code)) return 'unreadable-dataset';
  return 'invalid-evidence';
}

export async function checkSample(options) {
  const limits = checkOptions(options);
  const root = resolve(options.root);
  const datasetFile = safeFile(root, options.dataset);
  const planFile = safeFile(root, options.plan);
  const now = options.now ?? Date.now;
  const start = now();
  if (!Number.isFinite(start)) throw new SamplerConfigError('invalid-clock');
  const elapsed = () => {
    const current = now();
    if (!Number.isFinite(current) || current < start) throw new SamplerConfigError('invalid-clock');
    return current - start;
  };
  const parseLimits = { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes };
  let plan;
  try {
    plan = await readBoundedJson(resolve(root, options.plan), root, limits.maxBytes, parseLimits);
    validatePlan(plan);
  } catch (error) {
    if (error instanceof JsonEvidenceError || error instanceof PlanConfigError) throw new SamplerConfigError('invalid-plan');
    throw error;
  }
  if (elapsed() > limits.timeoutMs) return incompleteDatasetReport('timeout', datasetFile);
  let dataset;
  try {
    dataset = await readBoundedJson(resolve(root, options.dataset), root, limits.maxBytes, parseLimits);
  } catch (error) {
    if (error instanceof JsonEvidenceError) return incompleteDatasetReport(datasetRule(error.code), datasetFile);
    throw error;
  }
  const used = elapsed();
  if (used > limits.timeoutMs) return incompleteDatasetReport('timeout', datasetFile);
  try {
    return sampleDataset(dataset, plan, {
      maxCandidates: limits.maxCandidates, maxHoldout: limits.maxHoldout,
      timeoutMs: limits.timeoutMs - used, now, datasetFile, planFile,
    });
  } catch (error) {
    if (error instanceof PlanConfigError) throw new SamplerConfigError('invalid-plan');
    throw error;
  }
}
