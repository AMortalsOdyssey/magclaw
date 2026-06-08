import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createServerIo } from '../server/server-io.js';

function makeServerIo() {
  return createServerIo({
    addSystemEvent: () => {},
    getState: () => ({}),
    makeId: (prefix) => `${prefix}_test`,
    now: () => '2026-06-08T00:00:00.000Z',
    ATTACHMENTS_DIR: '/tmp',
    MAX_JSON_BYTES: 1024 * 1024,
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

  sendJson(res, 200, data);
  await res.ended;

  const compressed = Buffer.concat(res.chunks);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers.vary, 'accept-encoding');
  assert.deepEqual(JSON.parse(gunzipSync(compressed).toString('utf8')), data);
});

test('sendJson leaves small API payloads uncompressed', async () => {
  const { sendJson } = makeServerIo();
  const req = { headers: { 'accept-encoding': 'gzip' } };
  const res = makeResponse(req);
  const data = { ok: true };

  sendJson(res, 200, data);
  await res.ended;

  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), JSON.stringify(data));
});
