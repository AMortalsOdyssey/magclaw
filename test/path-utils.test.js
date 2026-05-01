import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  baseNameFromProjectPath,
  decodePathSegment,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safeFileName,
  safePathWithin,
  splitLines,
  toPosixPath,
} from '../server/path-utils.js';

test('path utilities normalize user paths and protect filesystem boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-path-'));
  try {
    assert.deepEqual(splitLines(' one\n\n two '), ['one', 'two']);
    assert.equal(safeFileName('bad/name?.txt'), 'bad-name-.txt');
    assert.equal(toPosixPath('foo\\bar/baz'), 'foo/bar/baz');
    assert.equal(decodePathSegment('%E4%BD%A0%E5%A5%BD.md'), '你好.md');
    assert.equal(normalizeProjectRelPath('/a//b/%E4%BD%A0%E5%A5%BD.md'), 'a/b/你好.md');
    assert.equal(baseNameFromProjectPath('a/b/file.md'), 'file.md');
    assert.equal(safePathWithin(root, 'notes/file.md'), path.join(root, 'notes/file.md'));
    assert.equal(safePathWithin(root, '../outside'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path utilities provide stable MIME and HTTP error helpers', () => {
  assert.equal(mimeForPath('readme.md'), 'text/plain');
  assert.equal(mimeForPath('asset.png'), 'image/png');
  assert.equal(mimeForPath('unknown.bin'), 'application/octet-stream');
  const error = httpError(413, 'too large');
  assert.equal(error.status, 413);
  assert.equal(error.message, 'too large');
});
