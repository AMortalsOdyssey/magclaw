import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DAEMON_VERSION,
  detectRuntimes,
  ensureMachineFingerprint,
  formatDaemonLogLine,
  parseCli,
  profilePaths,
} from '../daemon/src/cli.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_BIN = path.join(ROOT, 'daemon', 'bin', 'magclaw-daemon.js');
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function startHoldingWebSocketServer() {
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${WEBSOCKET_GUID}`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    },
  };
}

function waitForOutput(child, pattern, timeoutMs = 3000) {
  let output = '';
  const append = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)), timeoutMs);
    const check = () => {
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      resolve(output);
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
  });
}

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for daemon exit.')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('daemon profiles are isolated from localhost MagClaw state', () => {
  const env = { MAGCLAW_DAEMON_HOME: path.join(os.tmpdir(), 'magclaw-daemon-test') };
  const paths = profilePaths('cloud/admin user', env);
  assert.equal(paths.profile, 'cloud_admin_user');
  assert.match(paths.config, /\/profiles\/cloud_admin_user\/config\.json$/);
  assert.match(paths.owner, /\/profiles\/cloud_admin_user\/owner\.json$/);
  assert.doesNotMatch(paths.config, /state\.json|state\.sqlite|\/agents\//);

  const parsed = parseCli([
    'node',
    'magclaw-daemon',
    'connect',
    '--server-url',
    'https://example.test',
    '--pair-token',
    'mc_pair_test',
    '--background',
  ]);
  assert.equal(parsed.command, 'connect');
  assert.equal(parsed.flags.serverUrl, 'https://example.test');
  assert.equal(parsed.flags.pairToken, 'mc_pair_test');
  assert.equal(parsed.flags.background, true);

  const named = parseCli([
    'node',
    'magclaw-daemon',
    'connect',
    '--pair-token',
    'mc_pair_test',
    '--display-name',
    'Studio Mac',
  ]);
  assert.equal(named.flags.displayName, 'Studio Mac');
});

test('daemon version and foreground log lines are structured', () => {
  assert.equal(DAEMON_VERSION, '0.1.3');
  assert.equal(
    formatDaemonLogLine('info', 'daemon', 'MagClaw daemon ready.', new Date(2026, 4, 14, 8, 9, 10)),
    '2026-05-14 08:09:10 INFO DAEMON MagClaw daemon ready.',
  );
});

test('daemon sends a periodic heartbeat while the websocket is connected', async () => {
  const daemonSource = await readFile(new URL('../daemon/src/cli.js', import.meta.url), 'utf8');
  const relaySource = await readFile(new URL('../server/cloud/daemon-relay.js', import.meta.url), 'utf8');

  assert.match(daemonSource, /type: 'heartbeat'/);
  assert.match(daemonSource, /startHeartbeat\(\)/);
  assert.match(daemonSource, /this\.heartbeatIntervalMs/);
  assert.match(relaySource, /case 'heartbeat':/);
  assert.match(relaySource, /computer\.status = 'connected'/);
});

test('daemon machine fingerprint is stable inside a server profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-fingerprint-'));
  const env = { MAGCLAW_DAEMON_HOME: home };

  const first = await ensureMachineFingerprint('secondteam', env);
  const second = await ensureMachineFingerprint('secondteam', env);
  const other = await ensureMachineFingerprint('jianghaibo', env);

  assert.match(first.fingerprint, /^mfp_[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(other.fingerprint, first.fingerprint);
  assert.equal(first.profile, 'secondteam');
});

test('daemon runtime detection uses real commands and detects codex app-server', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-runtime-'));
  const fakeCodex = path.join(tmp, 'codex-fake.js');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  console.log('Usage: codex app-server --listen stdio://');
  process.exit(0);
}
process.exit(2);
`);
  await chmod(fakeCodex, 0o755);
  const runtimes = await detectRuntimes({
    ...process.env,
    CODEX_PATH: fakeCodex,
    CLAUDE_PATH: path.join(tmp, 'missing-claude'),
    GEMINI_PATH: path.join(tmp, 'missing-gemini'),
    KIMI_PATH: path.join(tmp, 'missing-kimi'),
    CURSOR_PATH: path.join(tmp, 'missing-cursor'),
    COPILOT_PATH: path.join(tmp, 'missing-copilot'),
    OPENCODE_PATH: path.join(tmp, 'missing-opencode'),
  });
  const codex = runtimes.find((runtime) => runtime.id === 'codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.appServer, true);
  assert.match(codex.version, /9\.9\.9/);
  assert.ok(codex.models.includes('gpt-5.5'));
  assert.equal(runtimes.find((runtime) => runtime.id === 'claude-code').installed, false);
  assert.ok(runtimes.find((runtime) => runtime.id === 'kimi'));
  assert.ok(runtimes.find((runtime) => runtime.id === 'cursor'));
  assert.ok(runtimes.find((runtime) => runtime.id === 'gemini'));
  assert.ok(runtimes.find((runtime) => runtime.id === 'copilot'));
  assert.ok(runtimes.find((runtime) => runtime.id === 'opencode'));
});

test('top-level daemon npm package dry-run excludes cloud server and deployment files', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', './daemon'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw-daemon.js'));
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/mcp-bridge.js'));
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.some((file) => file.startsWith('shared/')), false);
  assert.equal(files.includes('Dockerfile'), false);
  assert.equal(files.includes('kizuna.json'), false);
});

test('foreground daemon exits and clears its lock on SIGINT', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-sigint-'));
  const server = await startHoldingWebSocketServer();
  let child = null;
  let exitPromise = null;
  try {
    child = spawn(process.execPath, [
      DAEMON_BIN,
      'connect',
      '--server-url',
      server.baseUrl,
      '--pair-token',
      'mc_pair_test',
      '--profile',
      'sigint-test',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exitPromise = waitForExit(child);
    await waitForOutput(child, /Connecting MagClaw daemon profile "sigint-test"/);
    child.kill('SIGINT');
    const exit = await exitPromise;
    assert.equal(exit.code, 130);
    assert.equal(exit.signal, null);

    const status = spawnSync(process.execPath, [
      DAEMON_BIN,
      'status',
      '--profile',
      'sigint-test',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).running, false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exitPromise?.catch(() => {});
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('stop command stops a foreground daemon for the selected profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-stop-'));
  const server = await startHoldingWebSocketServer();
  let child = null;
  let exitPromise = null;
  try {
    child = spawn(process.execPath, [
      DAEMON_BIN,
      'connect',
      '--server-url',
      server.baseUrl,
      '--pair-token',
      'mc_pair_test',
      '--profile',
      'stop-test',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exitPromise = waitForExit(child);
    await waitForOutput(child, /Connecting MagClaw daemon profile "stop-test"/);

    const stopped = spawnSync(process.execPath, [
      DAEMON_BIN,
      'stop',
      '--profile',
      'stop-test',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    const payload = JSON.parse(stopped.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.process.pid, child.pid);
    assert.equal(payload.process.running, false);
    await exitPromise;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exitPromise?.catch(() => {});
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
