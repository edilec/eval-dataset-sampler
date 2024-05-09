import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUniqueJson, readBoundedJson, JsonEvidenceError } from '../src/json.mjs';

test('clean JSON is retained and escaped-equivalent duplicate keys are refused', () => {
  assert.deepEqual(parseUniqueJson('{"x":1,"nested":{"y":2}}'), { x: 1, nested: { y: 2 } });
  assert.throws(() => parseUniqueJson('{"x":1,"\\u0078":2}'), JsonEvidenceError);
  assert.throws(() => parseUniqueJson('{"x":{"y":1,"y":2}}'), JsonEvidenceError);
});

test('parser node and depth bounds accept N and refuse N+1', () => {
  assert.deepEqual(parseUniqueJson('[1,2]', { maxNodes: 3, maxDepth: 1 }), [1, 2]);
  assert.throws(() => parseUniqueJson('[1,2]', { maxNodes: 2 }), JsonEvidenceError);
  assert.throws(() => parseUniqueJson('[[1]]', { maxDepth: 1 }), JsonEvidenceError);
  assert.throws(() => parseUniqueJson('1e400'), JsonEvidenceError);
});

test('reader enforces bytes, strict UTF-8 and realpath confinement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edilec-sampler-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'edilec-sampler-outside-'));
  const path = join(root, 'data.json');
  await writeFile(path, '{"x":1}');
  assert.deepEqual(await readBoundedJson(path, root, 7), { x: 1 });
  await assert.rejects(readBoundedJson(path, root, 6), JsonEvidenceError);
  await symlink('data.json', join(root, 'inside.json'));
  assert.deepEqual(await readBoundedJson(join(root, 'inside.json'), root, 7), { x: 1 });
  await writeFile(join(outside, 'data.json'), '{"x":2}');
  await symlink(join(outside, 'data.json'), join(root, 'escape.json'));
  await assert.rejects(readBoundedJson(join(root, 'escape.json'), root, 7), JsonEvidenceError);
  await writeFile(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  await assert.rejects(readBoundedJson(path, root, 7), JsonEvidenceError);
});
