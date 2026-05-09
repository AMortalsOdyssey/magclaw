import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function launchIsolatedServer(tmp, extraEnv = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      DATABASE_URL: '',
      MAGCLAW_DATABASE_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  let stopped = false;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) {
        return {
          baseUrl,
          tmp,
          async stop(options = {}) {
            if (!stopped) {
              stopped = true;
              child.kill('SIGINT');
              await new Promise((resolve) => child.once('exit', resolve));
            }
            if (!options.keepTmp) await rm(tmp, { recursive: true, force: true });
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  child.kill('SIGINT');
  await rm(tmp, { recursive: true, force: true });
  throw new Error(`server did not start: ${output}`);
}

export async function startIsolatedServer(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-flow-'));
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
  return launchIsolatedServer(tmp, extraEnv);
}

export async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${data.error || response.statusText}`);
  }
  return data;
}

export async function startMockFanoutApi(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const requestBody = body ? JSON.parse(body) : {};
        calls.push({ url: req.url, headers: req.headers, body: requestBody });
        const decision = await handler(requestBody, calls[calls.length - 1]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(decision) } }],
        }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function readJsonLines(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function waitFor(predicate, timeoutMs = 4000) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return lastValue;
}

export async function readSseEvent(baseUrl, expectedEvent, timeoutMs = 1500) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expectedEvent}`)), remaining)),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const records = buffer.split(/\n\n/);
      buffer = records.pop() || '';
      for (const record of records) {
        const lines = record.split(/\n/);
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLine = lines.find((line) => line.startsWith('data: '));
        const event = eventLine?.slice('event: '.length);
        if (event === expectedEvent) return JSON.parse(dataLine?.slice('data: '.length) || '{}');
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  throw new Error(`Timed out waiting for ${expectedEvent}`);
}

export async function readSseEventFromReader(reader, decoder, expectedEvent, timeoutMs = 1500) {
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expectedEvent}`)), remaining)),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const records = buffer.split(/\n\n/);
    buffer = records.pop() || '';
    for (const record of records) {
      const lines = record.split(/\n/);
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      const event = eventLine?.slice('event: '.length);
      if (event === expectedEvent) return JSON.parse(dataLine?.slice('data: '.length) || '{}');
    }
  }
  throw new Error(`Timed out waiting for ${expectedEvent}`);
}

