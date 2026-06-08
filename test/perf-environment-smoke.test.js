import { strict as assert } from 'node:assert';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  authHeadersFromEnv,
  buildBootstrapPath,
  buildEventsPath,
  collectEnvironmentPerformance,
  createSseEventCounter,
  parseEnvironmentPerfArgs,
  summarizeJsonBody,
} from '../scripts/perf-environment-smoke.mjs';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('environment performance smoke records response sizes, timing headers, SSE mix, and redacts auth', async () => {
  const seen = {
    cookie: false,
    authorization: false,
    extra: false,
    compressedBootstrap: false,
  };
  const bootstrapBody = JSON.stringify({
    bootstrap: {
      directoryFormat: 'tuple-v1',
      directory: { scope: 'visible' },
      hasMoreMessages: true,
      unreadHydration: { included: 80, truncated: true },
      tasks: { space: { hasMore: true }, global: { hasMore: false } },
    },
    messages: [{ id: 'msg_1' }],
    replies: [],
    agents: [[1]],
    humans: [[1], [2]],
    tasks: [],
    cloud: { members: [[1], [2]] },
  });

  await withServer((req, res) => {
    seen.cookie ||= req.headers.cookie === 'sid=super-secret-cookie';
    seen.authorization ||= req.headers.authorization === 'Bearer super-secret-token';
    seen.extra ||= req.headers['x-magclaw-workspace'] === 'wsp_test';
    if (req.url === '/api/readyz') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'server-timing': 'ready;dur=3',
      });
      res.end(JSON.stringify({ ok: true, deployment: 'cloud' }));
      return;
    }
    if (req.url?.startsWith('/api/bootstrap')) {
      const shouldCompress = String(req.headers['accept-encoding'] || '').includes('gzip');
      seen.compressedBootstrap ||= shouldCompress;
      if (shouldCompress) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'server-timing': 'bootstrap;dur=9',
        });
        res.end(gzipSync(bootstrapBody));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'server-timing': 'bootstrap;dur=11',
      });
      res.end(bootstrapBody);
      return;
    }
    if (req.url?.startsWith('/api/events')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'server-timing': 'events;dur=1',
      });
      res.write(': keepalive\n\n');
      res.write('event: realtime-event\ndata: {"eventType":"agent_status"}\n\n');
      res.write('event: heartbeat\ndata: {"agents":[],"humans":[]}\n\n');
      setTimeout(() => res.end(), 5);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  }, async (baseUrl) => {
    const result = await collectEnvironmentPerformance({
      baseUrl,
      sseMs: 100,
      timeoutMs: 1000,
      env: {
        MAGCLAW_PERF_COOKIE: 'sid=super-secret-cookie',
        MAGCLAW_PERF_AUTH_HEADER: 'Bearer super-secret-token',
        MAGCLAW_PERF_EXTRA_HEADERS: JSON.stringify({ 'x-magclaw-workspace': 'wsp_test' }),
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.checks, {
      readyz: true,
      bootstrap: true,
      bootstrapCompressed: true,
      sse: true,
    });
    assert.equal(result.auth.cookie, true);
    assert.equal(result.auth.authorization, true);
    assert.deepEqual(result.auth.extraHeaderNames, ['x-magclaw-workspace']);
    assert.equal(result.samples.readyz.headers.serverTiming, 'ready;dur=3');
    assert.equal(result.samples.bootstrap.headers.serverTiming, 'bootstrap;dur=11');
    assert.equal(result.samples.bootstrap.body.collections.messages, 1);
    assert.equal(result.samples.bootstrap.body.collections.humans, 2);
    assert.equal(result.samples.bootstrap.body.collections.cloudMembers, 2);
    assert.equal(result.samples.bootstrap.body.bootstrap.directoryFormat, 'tuple-v1');
    assert.equal(result.samples.bootstrapCompressed.headers.contentEncoding, 'gzip');
    assert.equal(result.samples.bootstrapCompressed.body.decodedBytes, Buffer.byteLength(bootstrapBody));
    assert.equal(result.samples.sse.headers.serverTiming, 'events;dur=1');
    assert.equal(result.samples.sse.events['realtime-event'], 1);
    assert.equal(result.samples.sse.events.heartbeat, 1);
    assert.equal(result.samples.sse.comments, 1);
    assert.equal(result.samples.sse.bytes > 0, true);
    assert.equal(seen.cookie, true);
    assert.equal(seen.authorization, true);
    assert.equal(seen.extra, true);
    assert.equal(seen.compressedBootstrap, true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('super-secret-cookie'), false);
    assert.equal(serialized.includes('super-secret-token'), false);
  });
});

test('SSE counter handles comments, CRLF frames, default message events, and multiline data', () => {
  const counter = createSseEventCounter();
  counter.push(': first\r\n\r\n');
  counter.push('event: state-delta\r\ndata: {"a":1}\r\n\r\n');
  counter.push('data: line one\n');
  counter.push('data: line two\n\n');
  const summary = counter.finish();
  assert.equal(summary.comments, 1);
  assert.equal(summary.frames, 2);
  assert.equal(summary.events['state-delta'], 1);
  assert.equal(summary.events.message, 1);
  assert.equal(summary.dataBytesByEvent.message, Buffer.byteLength('line one\nline two'));
});

test('environment perf helpers build bounded bootstrap/SSE paths and summarize compressed JSON', () => {
  assert.equal(
    buildBootstrapPath({ spaceId: 'chan_perf', threadMessageId: 'msg_1', messageLimit: 20, threadRootLimit: 40 }),
    '/api/bootstrap?spaceType=channel&spaceId=chan_perf&messageLimit=20&threadRootLimit=40&directoryFormat=tuple-v1&conversationFormat=tuple-v1&directoryScope=visible&threadMessageId=msg_1',
  );
  assert.equal(
    buildEventsPath({ spaceType: 'dm', spaceId: 'dm_1', messageLimit: 12, threadRootLimit: 24 }),
    '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=12&threadRootLimit=24&directoryFormat=tuple-v1&conversationFormat=tuple-v1&directoryScope=visible&presence=defer',
  );
  const compressed = gzipSync(JSON.stringify({ messages: [1, 2], cloud: { members: [1] } }));
  const summary = summarizeJsonBody(compressed, {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
  });
  assert.equal(summary.json, true);
  assert.equal(summary.collections.messages, 2);
  assert.equal(summary.collections.cloudMembers, 1);
});

test('environment perf args and auth env keep secret values out of summaries', () => {
  const options = parseEnvironmentPerfArgs([
    '--base-url',
    'https://magclaw.example.test',
    '--space-id',
    'chan_live',
    '--allow-http-error',
  ], {
    MAGCLAW_PERF_COOKIE: 'sid=hidden',
    MAGCLAW_PERF_BEARER_TOKEN: 'token-hidden',
  });
  assert.equal(options.baseUrl, 'https://magclaw.example.test');
  assert.equal(options.spaceId, 'chan_live');
  assert.equal(options.allowHttpError, true);

  const { headers, summary } = authHeadersFromEnv({
    MAGCLAW_PERF_COOKIE: 'sid=hidden',
    MAGCLAW_PERF_BEARER_TOKEN: 'token-hidden',
  });
  assert.equal(headers.cookie, 'sid=hidden');
  assert.equal(headers.authorization, 'Bearer token-hidden');
  assert.deepEqual(summary, {
    cookie: true,
    authorization: true,
    extraHeaderNames: [],
  });
  const serializedSummary = JSON.stringify(summary);
  assert.equal(serializedSummary.includes('hidden'), false);
});
