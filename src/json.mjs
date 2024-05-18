import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';

export class JsonEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JsonEvidenceError';
    this.code = code;
  }
}

function boundedInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new JsonEvidenceError('invalid-limit');
  return value;
}

function canonicalDecimal(token) {
  const match = token.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u);
  if (!match) throw new JsonEvidenceError('numeric-precision');
  const fractional = match[3] ?? '';
  let digits = `${match[2]}${fractional}`.replace(/^0+/u, '');
  if (digits === '') return '0';
  const exponentDigits = (match[5] ?? '0').replace(/^0+/u, '') || '0';
  if (exponentDigits.length > 6) throw new JsonEvidenceError('numeric-precision');
  let exponent = BigInt(exponentDigits) * (match[4] === '-' ? -1n : 1n) - BigInt(fractional.length);
  const trailing = digits.match(/0+$/u)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += BigInt(trailing);
  return `${match[1]}${digits}e${exponent}`;
}

export function parseUniqueJson(text, options = {}) {
  if (typeof text !== 'string') throw new JsonEvidenceError('invalid-text');
  const maxDepth = boundedInteger(options.maxDepth, 16);
  const maxNodes = boundedInteger(options.maxNodes, 100_000);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JsonEvidenceError('malformed-json');
  }
  let i = 0;
  let nodes = 0;
  const ws = () => { while (/\s/u.test(text[i] ?? '') && i < text.length) i += 1; };
  const string = () => {
    const start = i;
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { i += 1; return JSON.parse(text.slice(start, i)); }
      i += 1;
    }
    throw new JsonEvidenceError('malformed-json');
  };
  const value = (depth) => {
    ws();
    nodes += 1;
    if (depth > maxDepth) throw new JsonEvidenceError('depth-limit');
    if (nodes > maxNodes) throw new JsonEvidenceError('node-limit');
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i += 1;
      const keys = new Set();
      ws();
      while (text[i] !== '}') {
        const key = string();
        if (keys.has(key)) throw new JsonEvidenceError('duplicate-key');
        keys.add(key);
        ws();
        i += 1;
        value(depth + 1);
        ws();
        if (text[i] !== ',') break;
        i += 1;
        ws();
      }
      i += 1;
      return;
    }
    if (text[i] === '[') {
      i += 1;
      ws();
      while (text[i] !== ']') {
        value(depth + 1);
        ws();
        if (text[i] !== ',') break;
        i += 1;
      }
      i += 1;
      return;
    }
    if (text[i] === 't') { i += 4; return; }
    if (text[i] === 'f') { i += 5; return; }
    if (text[i] === 'n') { i += 4; return; }
    const number = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!number) throw new JsonEvidenceError('malformed-json');
    const numeric = Number(number[0]);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER) throw new JsonEvidenceError('unsafe-number');
    if (canonicalDecimal(number[0]) !== canonicalDecimal(numeric.toString())) throw new JsonEvidenceError('numeric-precision');
    i += number[0].length;
  };
  value(0);
  return parsed;
}

export async function readBoundedJson(path, root, maxBytes = 1_048_576, options = {}) {
  if (typeof path !== 'string' || typeof root !== 'string') throw new JsonEvidenceError('invalid-path');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new JsonEvidenceError('invalid-limit');
  let realRoot;
  let realPath;
  try {
    realRoot = await realpath(resolve(root));
    realPath = await realpath(resolve(path));
  } catch {
    throw new JsonEvidenceError('unreadable');
  }
  const rel = relative(realRoot, realPath);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new JsonEvidenceError('outside-root');
  }
  let bytes;
  try {
    const info = await stat(realPath);
    if (!info.isFile()) throw new JsonEvidenceError('not-file');
    if (info.size > maxBytes) throw new JsonEvidenceError('byte-limit');
    bytes = await readFile(realPath);
  } catch (error) {
    if (error instanceof JsonEvidenceError) throw error;
    throw new JsonEvidenceError('unreadable');
  }
  if (bytes.length > maxBytes) throw new JsonEvidenceError('byte-limit');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new JsonEvidenceError('invalid-utf8');
  }
  return parseUniqueJson(decoded, options);
}
