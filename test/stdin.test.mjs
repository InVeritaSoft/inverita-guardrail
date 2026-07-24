import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readStream } from '../src/stdin.mjs';

test('readStream accumulates data chunks and resolves on end', async () => {
  const s = new PassThrough();
  const p = readStream(s);
  s.write('hello ');
  s.write('world');
  s.end();
  assert.equal(await p, 'hello world');
});

test('readStream fails open on stream error, resolving with what it buffered', async () => {
  const s = new PassThrough();
  const p = readStream(s);
  s.write('partial');
  // Emit an error instead of ending — the handler must resolve, not reject.
  queueMicrotask(() => s.emit('error', new Error('pipe broke')));
  assert.equal(await p, 'partial');
});
