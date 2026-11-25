import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createServerIo } from '../server/server-io.js';

function makeServerIo(overrides = {}) {
  return createServerIo({
    addSystemEvent: () => {},
    getState: () => ({}),
    makeId: (prefix) => `${prefix}_test`,
    now: () => '2026-06-08T00:00:00.000Z',
    ATTACHMENTS_DIR: '/tmp',
    MAX_JSON_BYTES: 1024 * 1024,
    ...overrides,
  });
}

function makeResponse(req = null) {
  let resolveEnd;
  const ended = new Promise((resolve) => {
    resolveEnd = resolve;
  });
  return {
    magclawRequest: req,
    statusCode: 0,
    headers: {},
    chunks: [],
    ended,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolveEnd();
    },
  };
}

test('sendJson gzip-compresses large API payloads when accepted', async () => {
  const { sendJson } = makeServerIo();
  const req = { headers: { 'accept-encoding': 'br, gzip' } };
  const res = makeResponse(req);
  const data = { items: Array.from({ length: 300 }, (_, index) => ({ index, text: 'MagClaw payload '.repeat(20) })) };

  sendJson(res, 200, data, { 'server-timing': 'project;dur=4, total;dur=5' });
  await res.ended;

  const compressed = Buffer.concat(res.chunks);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['server-timing'], 'project;dur=4, total;dur=5');
  assert.equal(res.headers.vary, 'accept-encoding');
  assert.deepEqual(JSON.parse(gunzipSync(compressed).toString('utf8')), data);
});

test('sendJson leaves small API payloads uncompressed', async () => {
  const { sendJson } = makeServerIo();
  const req = { headers: { 'accept-encoding': 'gzip' } };
  const res = makeResponse(req);
  const data = { ok: true };

  sendJson(res, 200, data, { 'server-timing': 'total;dur=1' });
  await res.ended;

  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.headers['server-timing'], 'total;dur=1');
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), JSON.stringify(data));
});

test('sendStaticFile returns 404 when a directory has no index', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magclaw-static-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { sendStaticFile } = makeServerIo();
  const res = makeResponse();

  await sendStaticFile(res, path.join(directory, 'index.html'), { 'content-type': 'text/html' });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks)), { error: 'Static file not found.' });
});

test('sendStaticFile returns a generic 500 when opening a file fails', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const { sendStaticFile } = makeServerIo({
    openStaticFile: async () => {
      throw Object.assign(new Error('fixture permission error'), { code: 'EACCES' });
    },
  });
  const res = makeResponse();

  await sendStaticFile(res, 'fixture.css', { 'content-type': 'text/css' });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks)), { error: 'Unable to read the static file.' });
  assert.equal(log.mock.callCount(), 1);
});

test('sendStaticFile isolates a read failure from the next HTTP request', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  let releaseRead;
  const afterFirstChunk = new Promise((resolve) => { releaseRead = resolve; });
  async function* interruptedRead() {
    yield Buffer.from('partial');
    await afterFirstChunk;
    throw Object.assign(new Error('fixture read error'), { code: 'EIO' });
  }

  let opened = 0;
  let closed = 0;
  const { sendStaticFile } = makeServerIo({
    openStaticFile: async () => {
      const chunks = ++opened === 1 ? interruptedRead() : [Buffer.from('ready')];
      return {
        stat: async () => ({ isFile: () => true }),
        createReadStream: () => Readable.from(chunks),
        close: async () => { closed += 1; },
      };
    },
  });
  const server = createServer((_req, res) => sendStaticFile(res, 'fixture.txt', {
    'content-type': 'text/plain',
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    releaseRead();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/`;

  const first = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const reader = first.body.getReader();
  const chunk = await reader.read();
  assert.equal(first.status, 200);
  assert.equal(Buffer.from(chunk.value).toString(), 'partial');
  releaseRead();
  await assert.rejects(reader.read());

  const next = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(next.status, 200);
  assert.equal(await next.text(), 'ready');
  assert.equal(log.mock.callCount(), 1);
  assert.equal(closed, 2);
});
