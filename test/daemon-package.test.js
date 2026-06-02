import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DAEMON_VERSION,
  CAPABILITIES,
  detectRuntimes,
  ensureMachineFingerprint,
  formatDaemonLogLine,
  parseCli,
  pathLooksEphemeralCli,
  profilePaths,
  renderCliShimFiles,
  runtimeSearchPathEntries,
  runtimeCommandHasPathSeparator,
  runtimeCommandNeedsShell,
  parseLaunchdPrintStatus,
  selectRuntimeCommandPath,
  serviceStatePatchForDaemonRun,
  toWebSocketUrl,
  windowsNpmShimScript,
} from '../cli-core/src/cli.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DAEMON_BIN = path.join(ROOT, 'daemon', 'bin', 'magclaw-daemon.js');
const COMPUTER_BIN = path.join(ROOT, 'computer', 'bin', 'magclaw-computer.js');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

async function waitForDaemonStatus(env, profile, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastPayload = null;
  let lastOutput = '';
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'status',
      '--profile',
      profile,
    ], {
      env,
      encoding: 'utf8',
    });
    lastOutput = result.stderr || result.stdout;
    if (result.status === 0) {
      lastPayload = JSON.parse(result.stdout);
      if (predicate(lastPayload)) return lastPayload;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for daemon status: ${lastOutput || JSON.stringify(lastPayload)}`);
}

function regexpEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('daemon profiles are isolated from localhost MagClaw state', () => {
  const env = { MAGCLAW_DAEMON_HOME: path.join(os.tmpdir(), 'magclaw-daemon-test') };
  const paths = profilePaths('cloud/admin user', env);
  assert.equal(paths.profile, 'cloud_admin_user');
  assert.equal(path.normalize(paths.config).endsWith(path.join('profiles', 'cloud_admin_user', 'config.json')), true);
  assert.equal(path.normalize(paths.owner).endsWith(path.join('profiles', 'cloud_admin_user', 'owner.json')), true);
  assert.doesNotMatch(path.normalize(paths.config), /state\.json|state\.sqlite|[\\/]agents[\\/]/);

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

  const upgrade = parseCli([
    'node',
    'magclaw',
    'upgrade',
    '--to',
    '0.1.11',
    '--dry-run',
    '--json',
  ]);
  assert.equal(upgrade.command, 'upgrade');
  assert.equal(upgrade.flags.to, '0.1.11');
  assert.equal(upgrade.flags.dryRun, true);
  assert.equal(upgrade.flags.json, true);

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

  const apiKey = parseCli([
    'node',
    'magclaw-daemon',
    '--server-url',
    'https://example.test',
    '--api-key',
    'mc_machine_test',
  ]);
  assert.equal(apiKey.command, 'connect');
  assert.equal(apiKey.flags.apiKey, 'mc_machine_test');

  const computerSetup = parseCli([
    'node',
    'magclaw',
    'computer',
    'setup',
    '/second-team',
    '--server-url',
    'https://example.test',
  ]);
  assert.equal(computerSetup.command, 'computer');
  assert.deepEqual(computerSetup.flags._, ['setup', '/second-team']);
  assert.equal(computerSetup.flags.serverUrl, 'https://example.test');
});

test('launchd status only reports active for actually running services', () => {
  const running = parseLaunchdPrintStatus({
    status: 0,
    stdout: [
      'gui/501/ai.magclaw.daemon.example = {',
      '\tactive count = 1',
      '\tstate = running',
      '}',
    ].join('\n'),
  });
  assert.equal(running.active, true);
  assert.equal(running.status, 'running');

  const scheduled = parseLaunchdPrintStatus({
    status: 0,
    stdout: [
      'gui/501/ai.magclaw.daemon.example = {',
      '\tactive count = 0',
      '\tstate = spawn scheduled',
      '\tlast exit code = 0',
      '}',
    ].join('\n'),
  });
  assert.equal(scheduled.active, false);
  assert.equal(scheduled.status, 'spawn scheduled');

  const missing = parseLaunchdPrintStatus({
    status: 113,
    stderr: 'Could not find service "ai.magclaw.daemon.example" in domain.',
  });
  assert.equal(missing.active, false);
  assert.match(missing.error, /Could not find service/);
});

test('daemon run service state preserves launchd background mode for service-launched workers', () => {
  assert.deepEqual(
    serviceStatePatchForDaemonRun({ mode: 'launchd', background: true }, { MAGCLAW_DAEMON_BACKGROUND_SERVICE: '1' }, 'darwin'),
    { mode: 'launchd', background: true },
  );
  assert.deepEqual(
    serviceStatePatchForDaemonRun({}, { MAGCLAW_DAEMON_BACKGROUND_SERVICE: '1', MAGCLAW_DAEMON_SERVICE_MODE: 'container' }, 'linux'),
    { mode: 'container', background: true },
  );
  assert.deepEqual(
    serviceStatePatchForDaemonRun({}, {}, 'darwin'),
    { mode: 'foreground', background: false },
  );
});

test('daemon version and foreground log lines are structured', () => {
  assert.equal(DAEMON_VERSION, '0.1.40');
  assert.equal(
    formatDaemonLogLine('info', 'daemon', 'MagClaw daemon ready.', new Date(2026, 4, 14, 8, 9, 10)),
    '2026-05-14 08:09:10 INFO DAEMON MagClaw daemon ready.',
  );
});

test('foreground daemon connection log includes the running package version', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const connectSource = source.slice(source.indexOf('async connectOnce()'), source.indexOf('async runForever()'));
  assert.match(connectSource, /const packageInfo = runtimePackageInfo\(this\.env, service\)/);
  assert.match(connectSource, /Connecting MagClaw daemon v\$\{packageInfo\.version \|\| DAEMON_VERSION\} profile/);
});

test('foreground daemon sends lightweight ready before deferred runtime scan', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const readyPayloadSource = source.slice(source.indexOf('async readyPayload()'), source.indexOf('async sendReady()'));
  const readyAckSource = source.slice(source.indexOf("case 'ready:ack':"), source.indexOf("case 'ping':"));
  assert.doesNotMatch(readyPayloadSource, /detectRuntimes/);
  assert.match(readyPayloadSource, /runtimeScanPending: true/);
  assert.match(readyAckSource, /this\.scheduleRuntimeStatus\('ready_ack'\)/);
  assert.match(source, /type: 'daemon:runtime_status'/);
});

test('daemon websocket auth prefers durable api keys over stale pair tokens', () => {
  const url = toWebSocketUrl('https://magclaw.multiego.me', {
    token: 'mc_machine_test',
    pairToken: 'mc_pair_stale',
    fingerprint: 'mfp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('token'), 'mc_machine_test');
  assert.equal(url.searchParams.get('pair_token'), null);
  assert.equal(url.searchParams.get('machine_fingerprint'), 'mfp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('daemon sends a periodic heartbeat while the websocket is connected', async () => {
  const daemonSource = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const relaySource = await readFile(new URL('../server/cloud/daemon-relay.js', import.meta.url), 'utf8');

  assert.match(daemonSource, /type: 'heartbeat'/);
  assert.match(daemonSource, /startHeartbeat\(\)/);
  assert.match(daemonSource, /this\.heartbeatIntervalMs/);
  assert.match(daemonSource, /Sent ready payload for computer/);
  assert.match(daemonSource, /Sent heartbeat/);
  assert.match(daemonSource, /Received \$\{frameType\}/);
  assert.match(daemonSource, /local agent sessions continue running until reconnect/);
  assert.match(daemonSource, /MAGCLAW_DAEMON_INBOUND_WATCHDOG_MS/);
  assert.match(daemonSource, /resetInboundWatchdog\(\)/);
  assert.match(daemonSource, /No inbound daemon traffic/);
  assert.match(daemonSource, /type: 'daemon:stopping'/);
  assert.match(daemonSource, /MAGCLAW_DAEMON_RECONNECT_MAX_MS/);
  assert.match(daemonSource, /agent:activity_probe/);
  assert.match(daemonSource, /handleAgentActivityProbe\(message\)/);
  assert.match(relaySource, /case 'heartbeat':/);
  assert.match(relaySource, /MAGCLAW_DAEMON_PING_MS/);
  assert.match(relaySource, /MAGCLAW_DAEMON_ACTIVITY_PROBE_TIMEOUT_MS/);
  assert.match(relaySource, /DAEMON_PING_MS = readMsEnv\('MAGCLAW_DAEMON_PING_MS', 5_000, \{ min: 0, max: 10 \* 60_000 \}\)/);
  assert.match(relaySource, /DAEMON_INBOUND_WATCHDOG_MS = readMsEnv\('MAGCLAW_DAEMON_INBOUND_WATCHDOG_MS', 15_000, \{ min: 0, max: 10 \* 60_000 \}\)/);
  assert.match(relaySource, /DEFAULT_DAEMON_RECONNECT_GRACE_MS = readMsEnv\('MAGCLAW_DAEMON_RECONNECT_GRACE_MS', 10_000, \{ min: 0, max: 5 \* 60_000 \}\)/);
  assert.match(relaySource, /startConnectionPing\(connection\)/);
  assert.match(relaySource, /probeStaleAgentHeartbeats\(\)/);
  assert.match(relaySource, /case 'daemon:stopping':/);
  assert.match(relaySource, /case 'pong':/);
  assert.match(relaySource, /computer\.status = 'connected'/);
});

test('daemon agent starts and stream activity use MagClaw bounded scheduling', async () => {
  const daemonSource = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const mcpBridgeSource = await readFile(new URL('../cli-core/src/mcp-bridge.js', import.meta.url), 'utf8');

  assert.match(daemonSource, /DEFAULT_MAX_CONCURRENT_AGENT_STARTS = 5/);
  assert.match(daemonSource, /DEFAULT_AGENT_START_INTERVAL_MS = 500/);
  assert.match(daemonSource, /MAGCLAW_DAEMON_MAX_CONCURRENT_AGENT_STARTS/);
  assert.match(daemonSource, /enqueueAgentStart\(agent\.id/);
  assert.match(daemonSource, /pumpAgentStartQueue\(\)/);
  assert.match(daemonSource, /DEFAULT_TRAJECTORY_COALESCE_MS = 350/);
  assert.match(daemonSource, /MAGCLAW_DAEMON_TRAJECTORY_COALESCE_MS/);
  assert.match(daemonSource, /queueCodexStreamActivity\(\)/);
  assert.match(daemonSource, /flushCodexStreamActivity\(\)/);
  assert.match(daemonSource, /propose_channel_members/);
  assert.match(daemonSource, /\/api\/agent-tools\/channel-member-proposals/);
  assert.match(mcpBridgeSource, /name: 'propose_channel_members'/);
  assert.match(mcpBridgeSource, /\/api\/agent-tools\/channel-member-proposals/);
  assert.match(mcpBridgeSource, /name: 'read_agent_avatar'/);
  assert.match(mcpBridgeSource, /\/api\/agent-tools\/agents\/avatar\/read/);
  assert.match(mcpBridgeSource, /type: 'image'/);
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
  const fakeCodex = path.join(tmp, process.platform === 'win32' ? 'codex-fake.cmd' : 'codex-fake.js');
  if (process.platform === 'win32') {
    await writeFile(fakeCodex, `@echo off
if "%~1"=="--version" (
  echo codex-cli 9.9.9
  exit /b 0
)
if "%~1"=="app-server" if "%~2"=="--help" (
  echo Usage: codex app-server --listen stdio://
  exit /b 0
)
exit /b 2
`);
  } else {
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
  }
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

test('daemon runtime detection searches user bin directories with a minimal launchd path', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-user-bin-'));
  const fakeHome = path.join(tmp, 'home');
  const userBin = path.join(fakeHome, '.local', 'bin');
  await mkdir(userBin, { recursive: true });
  const fakeKimi = path.join(userBin, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
  if (process.platform === 'win32') {
    await writeFile(fakeKimi, '@echo off\necho kimi, version 9.8.7\n');
  } else {
    await writeFile(fakeKimi, '#!/bin/sh\necho "kimi, version 9.8.7"\n');
    await chmod(fakeKimi, 0o755);
  }

  const env = {
    PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    KIMI_PATH: '',
    CLAUDE_PATH: path.join(tmp, 'missing-claude'),
    GEMINI_PATH: path.join(tmp, 'missing-gemini'),
    CURSOR_PATH: path.join(tmp, 'missing-cursor'),
    COPILOT_PATH: path.join(tmp, 'missing-copilot'),
    OPENCODE_PATH: path.join(tmp, 'missing-opencode'),
  };
  const entries = runtimeSearchPathEntries(env);
  assert.ok(entries.includes(userBin));
  const runtimes = await detectRuntimes(env);
  const kimi = runtimes.find((runtime) => runtime.id === 'kimi');
  assert.equal(kimi.installed, true);
  assert.equal(path.resolve(kimi.path), path.resolve(fakeKimi));
  assert.match(kimi.version, /9\.8\.7/);
});

test('computer setup result prints the connected computer name', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const setupSource = source.slice(source.indexOf('async function runComputerSetup'), source.indexOf('async function buildConfig'));
  assert.match(setupSource, /computerName: config\.computerName \|\| config\.name \|\| displayName/);
  assert.ok(setupSource.indexOf('computerId: config.computerId') < setupSource.indexOf('computerName:'));
});

test('remote delivery workspace prefers the source message over the relay envelope', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const deliverSource = source.slice(source.indexOf('async handleAgentDeliver'), source.indexOf('async handleAgentStop'));
  assert.match(deliverSource, /message\.payload\?\.message\?\.workspaceId/);
  assert.match(deliverSource, /message\.workspaceId/);
  assert.ok(
    deliverSource.indexOf('message.payload?.message?.workspaceId') < deliverSource.indexOf('message.workspaceId'),
  );
});

test('computer setup reuses a saved matched profile without opening device approval', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-computer-reuse-'));
  let setupRequests = 0;
  const server = http.createServer((_req, res) => {
    setupRequests += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'setup should not be called for an already matched profile' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { ...process.env, MAGCLAW_DAEMON_HOME: home, MAGCLAW_INSTALL_CLI: '0' };
    const paths = profilePaths('alpha-team', env);
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify({
      profile: paths.profile,
      serverUrl,
      workspaceId: 'wk_alpha',
      computerId: 'cmp_alpha',
      name: 'Studio Mac',
      serverName: 'Alpha Team',
      serverSlug: 'alpha-team',
      fingerprint: 'mfp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token: 'mc_machine_secret',
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
    }, null, 2));

    const result = spawnSync(process.execPath, [
      COMPUTER_BIN,
      'setup',
      '/alpha-team',
      '--server-url',
      serverUrl,
      '--no-start',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(setupRequests, 0);
    assert.doesNotMatch(result.stdout, /To finish login/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.started, false);
    assert.equal(payload.reused, true);
    assert.equal(payload.reason, 'already_configured');
    assert.equal(payload.computerId, 'cmp_alpha');
    assert.equal(payload.profile, 'alpha-team');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('daemon runtime command helpers handle Windows Codex CLI paths', () => {
  assert.equal(runtimeCommandHasPathSeparator('C:\\Users\\tt\\AppData\\Roaming\\npm\\codex.cmd'), true);
  assert.equal(runtimeCommandHasPathSeparator('C:/Users/tt/AppData/Roaming/npm/codex.cmd'), true);
  assert.equal(runtimeCommandHasPathSeparator('codex'), false);
  assert.equal(runtimeCommandNeedsShell('C:\\Users\\tt\\AppData\\Roaming\\npm\\codex.cmd', 'win32'), true);
  assert.equal(runtimeCommandNeedsShell('C:/Users/tt/AppData/Roaming/npm/codex.bat', 'win32'), true);
  assert.equal(runtimeCommandNeedsShell('/usr/local/bin/codex', 'darwin'), false);
});

test('daemon prefers Windows command shims that Node can launch', () => {
  const output = [
    'C:\\Users\\tt\\AppData\\Roaming\\npm\\codex',
    'C:\\Users\\tt\\AppData\\Roaming\\npm\\codex.cmd',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe',
  ].join('\n');
  assert.equal(selectRuntimeCommandPath(output, 'codex', 'win32'), 'C:\\Users\\tt\\AppData\\Roaming\\npm\\codex.cmd');
  assert.equal(selectRuntimeCommandPath(output, 'codex', 'linux'), 'C:\\Users\\tt\\AppData\\Roaming\\npm\\codex');
});

test('daemon resolves Windows npm command shims to their JS entrypoint', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cmd-shim-'));
  try {
    const shim = path.join(tmp, 'codex.cmd');
    const entry = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, 'console.log("codex")\n');
    await writeFile(shim, '@ECHO off\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n');
    assert.equal(windowsNpmShimScript(shim, 'win32'), entry);
    assert.equal(windowsNpmShimScript(shim, 'linux'), '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('top-level daemon npm package dry-run excludes cloud server and deployment files', () => {
  const result = spawnSync(NPM_BIN, ['pack', '--dry-run', '--json', './daemon'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw-daemon.js'));
  assert.ok(files.includes('bin/magclaw.js'));
  assert.equal(files.some((file) => file.startsWith('src/')), false);
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.some((file) => file.startsWith('shared/')), false);
  assert.equal(files.includes('Dockerfile'), false);
  assert.equal(files.includes('kizuna.json'), false);
});

test('daemon and computer packages share CLI core without depending on each other', async () => {
  const daemonPackage = JSON.parse(await readFile(new URL('../daemon/package.json', import.meta.url), 'utf8'));
  const computerPackage = JSON.parse(await readFile(new URL('../computer/package.json', import.meta.url), 'utf8'));
  const cliCorePackage = JSON.parse(await readFile(new URL('../cli-core/package.json', import.meta.url), 'utf8'));

  assert.equal(cliCorePackage.name, '@magclaw/cli-core');
  assert.equal(cliCorePackage.version, DAEMON_VERSION);
  assert.equal(daemonPackage.dependencies['@magclaw/cli-core'], DAEMON_VERSION);
  assert.equal(computerPackage.dependencies['@magclaw/cli-core'], DAEMON_VERSION);
  assert.equal(computerPackage.dependencies['@magclaw/daemon'], undefined);
  assert.equal(daemonPackage.dependencies['@magclaw/computer'], undefined);
});

test('computer npm package is a thin setup wrapper around the shared CLI core package', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'magclaw-computer-cli-'));
  const computerPackage = JSON.parse(await readFile(new URL('../computer/package.json', import.meta.url), 'utf8'));
  const computerBin = await readFile(new URL('../computer/bin/magclaw-computer.js', import.meta.url), 'utf8');

  try {
    assert.equal(computerPackage.name, '@magclaw/computer');
    assert.equal(computerPackage.version, DAEMON_VERSION);
    assert.deepEqual(computerPackage.bin, { 'magclaw-computer': 'bin/magclaw-computer.js' });
    assert.equal(computerPackage.dependencies['@magclaw/cli-core'], DAEMON_VERSION);
    assert.equal(computerPackage.dependencies['@magclaw/daemon'], undefined);
    assert.match(computerBin, /@magclaw\/cli-core\/src\/cli\.js/);
    assert.doesNotMatch(computerBin, /@magclaw\/daemon\/src\/cli\.js/);
    assert.match(computerBin, /MAGCLAW_COMPUTER_DAEMON/);
    assert.match(computerBin, /\['computer', \.\.\.args\]/);

    const help = spawnSync(process.execPath, [COMPUTER_BIN, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /MagClaw Computer CLI/);
    assert.match(help.stdout, /login \[options\] <serverSlug>/);
    assert.match(help.stdout, /attach \[options\] <serverSlug>/);
    assert.match(help.stdout, /doctor \[options\] \[serverSlug\]/);
    assert.match(help.stdout, /runners\s+Computer runner control plane/);

    const attachHelp = spawnSync(process.execPath, [COMPUTER_BIN, 'attach', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(attachHelp.status, 0, attachHelp.stderr || attachHelp.stdout);
    assert.match(attachHelp.stdout, /Usage: magclaw-computer attach/);
    assert.match(attachHelp.stdout, /--no-run/);

    const statusResult = spawnSync(process.execPath, [COMPUTER_BIN, 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: tempHome,
      },
    });
    assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
    const statusReport = JSON.parse(statusResult.stdout);
    assert.equal(statusReport.supervisor.model, 'per-profile-service');
    assert.deepEqual(statusReport.profiles, []);

    const runnersResult = spawnSync(process.execPath, [COMPUTER_BIN, 'runners', 'list'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: tempHome,
      },
    });
    assert.equal(runnersResult.status, 0, runnersResult.stderr || runnersResult.stdout);
    const runnersReport = JSON.parse(runnersResult.stdout);
    assert.match(runnersReport.note, /Per-agent runner stop\/list remains/);
    assert.deepEqual(runnersReport.profiles, []);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('computer wrapper marks background services as the computer package and can pass through daemon commands', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'magclaw-computer-wrapper-'));
  try {
    const computerBin = await readFile(new URL('../computer/bin/magclaw-computer.js', import.meta.url), 'utf8');
    assert.match(computerBin, /MAGCLAW_ENTRY_PACKAGE_NAME/);
    assert.match(computerBin, /@magclaw\/computer/);
    assert.match(computerBin, /MAGCLAW_DAEMON_PACKAGE_BIN/);
    assert.match(computerBin, /MAGCLAW_COMPUTER_DAEMON/);

    const result = spawnSync(process.execPath, [COMPUTER_BIN, 'status', '--profile', 'computer-pass-through'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: tempHome,
        MAGCLAW_COMPUTER_DAEMON: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = JSON.parse(result.stdout);
    assert.equal(status.profile, 'computer-pass-through');
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('upgrade worker targets the current entry package instead of always upgrading daemon', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'magclaw-computer-upgrade-'));
  try {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'upgrade-worker',
      '--dry-run',
      '--profile',
      'computer-upgrade',
      '--target-version',
      '0.1.30',
      '--package-name',
      '@magclaw/computer',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: tempHome,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.packageSpec, '@magclaw/computer@0.1.30');
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('top-level CLI core npm package carries the shared command implementation', () => {
  const result = spawnSync(NPM_BIN, ['pack', '--dry-run', '--json', './cli-core'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw.js'));
  assert.ok(files.includes('bin/magclaw-daemon.js'));
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/cli-core/args.js'));
  assert.ok(files.includes('src/cli-core/team-sharing-delegate.js'));
  assert.ok(files.includes('src/list-renderer.js'));
  assert.ok(files.includes('src/mcp-bridge.js'));
  assert.equal(files.includes('src/team-sharing.js'), false);
  assert.equal(files.includes('src/team-sharing-hooks.js'), false);
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.includes('Dockerfile'), false);
});

test('CLI core delegates Team Sharing without importing the Team Sharing implementation', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  const delegate = await readFile(new URL('../cli-core/src/cli-core/team-sharing-delegate.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /from ['"]\.\/team-sharing(?:-hooks)?\.js['"]/);
  assert.match(source, /runExternalTeamSharingCommand\(argv\.slice\(3\), env\)/);
  assert.match(delegate, /MAGCLAW_TEAM_SHARING_BIN/);
  assert.match(delegate, /Team Sharing is packaged separately/);
});

test('top-level computer npm package dry-run excludes cloud server and deployment files', () => {
  const result = spawnSync(NPM_BIN, ['pack', '--dry-run', '--json', './computer'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw-computer.js'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('package.json'));
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('daemon/src/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.includes('Dockerfile'), false);
});

test('daemon package exposes one OpenClaw-style CLI bin for npx default execution', async () => {
  const daemonPackage = JSON.parse(await readFile(new URL('../daemon/package.json', import.meta.url), 'utf8'));
  const daemonBin = await readFile(new URL('../daemon/bin/magclaw.js', import.meta.url), 'utf8');
  assert.deepEqual(daemonPackage.bin, { magclaw: 'bin/magclaw.js' });
  assert.equal(daemonPackage.dependencies['@magclaw/cli-core'], DAEMON_VERSION);
  assert.match(daemonBin, /MAGCLAW_DAEMON_PACKAGE_SPEC/);
  assert.ok(CAPABILITIES.includes('daemon:upgrade'));
});

test('shared CLI core does not pin computer-launched daemons to the CLI core version', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@magclaw\/daemon@\$\{DAEMON_VERSION\}/);
  assert.match(source, /function runtimePackageInfo\(/);
  assert.match(source, /previousService\.pendingCommandId/);
  assert.match(source, /packageSpecForPackageName\(packageInfo\.name, 'latest'\)/);
});

test('daemon renders durable magclaw and computer CLI shims for macOS Linux and Windows', () => {
  const macFiles = renderCliShimFiles({
    platform: 'darwin',
    npmPath: '/opt/homebrew/bin/npm',
    packageSpec: '@magclaw/cli-core@latest',
  });
  assert.deepEqual(macFiles.map((file) => file.name), ['magclaw', 'magclaw-computer']);
  assert.match(macFiles[0].content, /^#!\/bin\/sh/);
  assert.match(macFiles[0].content, /MagClaw CLI shim generated by @magclaw\/cli-core/);
  assert.match(macFiles[0].content, /@magclaw\/cli-core@latest/);
  assert.match(macFiles[0].content, /exec "\$NPM_BIN" exec --yes --package "\$PACKAGE_SPEC" -- magclaw "\$@"/);
  assert.match(macFiles[1].content, /@magclaw\/computer@latest/);
  assert.match(macFiles[1].content, /exec "\$NPM_BIN" exec --yes --package "\$PACKAGE_SPEC" -- magclaw-computer "\$@"/);

  const linuxFiles = renderCliShimFiles({
    platform: 'linux',
    npmPath: '/usr/bin/npm',
    packageSpec: '@magclaw/cli-core@latest',
  });
  assert.deepEqual(linuxFiles.map((file) => file.name), ['magclaw', 'magclaw-computer']);
  assert.match(linuxFiles[0].content, /NPM_BIN='\/usr\/bin\/npm'/);

  const windowsFiles = renderCliShimFiles({
    platform: 'win32',
    npmPath: 'C:\\Users\\tt\\AppData\\Roaming\\npm\\npm.cmd',
    packageSpec: '@magclaw/cli-core@latest',
  });
  assert.deepEqual(windowsFiles.map((file) => file.name), [
    'magclaw.cmd',
    'magclaw.ps1',
    'magclaw-computer.cmd',
    'magclaw-computer.ps1',
  ]);
  assert.match(windowsFiles[0].content, /@echo off/);
  assert.match(windowsFiles[0].content, /@magclaw\/cli-core@latest/);
  assert.match(windowsFiles[0].content, /%ARGS%/);
  assert.match(windowsFiles[1].content, /@args/);
  assert.match(windowsFiles[2].content, /@magclaw\/computer@latest/);
  assert.match(windowsFiles[2].content, /magclaw-computer %ARGS%/);
});

test('daemon ignores transient npx and npm run-script PATH directories for CLI shim install', () => {
  assert.equal(pathLooksEphemeralCli('/Users/tt/.npm/_npx/abc/node_modules/.bin'), true);
  assert.equal(pathLooksEphemeralCli('/Users/tt/project/node_modules/.bin'), true);
  assert.equal(
    pathLooksEphemeralCli('/Users/tt/.nvm/versions/node/v22.17.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin'),
    true,
  );
  assert.equal(pathLooksEphemeralCli('/Users/tt/.local/bin'), false);
});

test('install-cli command writes durable magclaw and computer command shims', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-home-'));
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-bin-'));
  try {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'install-cli',
      '--bin-dir',
      binDir,
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'magclaw');
    assert.deepEqual(payload.commands, ['magclaw', 'magclaw-computer']);
    assert.equal(payload.installed, true);
    assert.equal(payload.reason, 'installed');
    assert.equal(payload.pathReady, true);
    assert.ok(payload.files.length >= 1);
    assert.ok(payload.shims.every((shim) => shim.changed === true));
    assert.ok(payload.shims.every((shim) => shim.upToDate === true));
    assert.ok(payload.shims.every((shim) => shim.currentHash === shim.expectedHash));

    const files = await readdir(binDir);
    if (process.platform === 'win32') {
      assert.ok(files.includes('magclaw.cmd'));
      assert.ok(files.includes('magclaw.ps1'));
      assert.ok(files.includes('magclaw-computer.cmd'));
      assert.ok(files.includes('magclaw-computer.ps1'));
    } else {
      assert.deepEqual(files, ['magclaw', 'magclaw-computer']);
      const shim = await readFile(path.join(binDir, 'magclaw'), 'utf8');
      const computerShim = await readFile(path.join(binDir, 'magclaw-computer'), 'utf8');
      assert.match(shim, /exec "\$NPM_BIN" exec/);
      assert.match(shim, /@magclaw\/cli-core@latest/);
      assert.match(computerShim, /exec "\$NPM_BIN" exec/);
      assert.match(computerShim, /@magclaw\/computer@latest/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test('install-cli skips current command shims after content hash inspection', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-current-home-'));
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-current-bin-'));
  try {
    const args = [
      DAEMON_BIN,
      'install-cli',
      '--bin-dir',
      binDir,
    ];
    const first = spawnSync(process.execPath, args, {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const second = spawnSync(process.execPath, args, {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.installed, false);
    assert.equal(payload.updated, false);
    assert.equal(payload.reason, 'already_current');
    assert.deepEqual(payload.changedFiles, []);
    assert.ok(payload.shims.every((shim) => shim.changed === false));
    assert.ok(payload.shims.every((shim) => shim.reason === 'current'));
    assert.ok(payload.shims.every((shim) => shim.currentHash === shim.expectedHash));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test('restore command requires saved daemon credentials for the selected profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-restore-empty-'));
  try {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'restore',
      '--profile',
      'missing-profile',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No saved MagClaw daemon credentials for profile "missing-profile"/);
    assert.doesNotMatch(result.stderr, /Unknown command/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('install-cli repairs a missing magclaw-computer shim next to existing magclaw', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-repair-home-'));
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-repair-bin-'));
  try {
    await writeFile(path.join(binDir, 'magclaw'), [
      '#!/bin/sh',
      'set -eu',
      '# MagClaw CLI shim generated by @magclaw/cli-core.',
      "exec npm exec --yes --package '@magclaw/cli-core@latest' -- magclaw \"$@\"",
      '',
    ].join('\n'));
    await chmod(path.join(binDir, 'magclaw'), 0o755);

    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'install-cli',
    ], {
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: home,
        PATH: binDir,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.installed, true);
    assert.equal(payload.reason, 'updated');
    assert.equal(payload.binDir, binDir);
    assert.ok(payload.files.some((file) => path.basename(file) === 'magclaw-computer'));
    const magclawShim = payload.shims.find((shim) => shim.command === 'magclaw');
    const computerShimPayload = payload.shims.find((shim) => shim.command === 'magclaw-computer');
    assert.equal(magclawShim.reason, 'outdated');
    assert.equal(magclawShim.changed, true);
    assert.equal(magclawShim.upToDate, true);
    assert.equal(computerShimPayload.reason, 'missing');
    assert.equal(computerShimPayload.changed, true);
    assert.equal(computerShimPayload.upToDate, true);

    const files = await readdir(binDir);
    assert.deepEqual(files.sort(), ['magclaw', 'magclaw-computer']);
    const computerShim = await readFile(path.join(binDir, 'magclaw-computer'), 'utf8');
    assert.match(computerShim, /@magclaw\/computer@latest/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test('help flags describe restart list and daemon control commands', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = spawnSync(process.execPath, [DAEMON_BIN, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: magclaw/);
    assert.match(result.stdout, /computer\s+Pair this local computer with a server using browser approval/);
    assert.match(result.stdout, /restart\s+Restart a saved background daemon profile/);
    assert.match(result.stdout, /list\s+List local daemon profiles and connected Computers/);
    assert.match(result.stdout, /--json\s+Print machine-readable output for list/);
    assert.match(result.stdout, /stop\s+Stop a daemon profile/);
    assert.match(result.stdout, /restore\s+Legacy alias for restart/);
  }
});

test('list command renders saved local daemon profiles as a readable table', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-list-profiles-'));
  try {
    const alpha = profilePaths('alpha server', { MAGCLAW_DAEMON_HOME: home });
    const beta = profilePaths('beta', { MAGCLAW_DAEMON_HOME: home });
    const empty = profilePaths('empty', { MAGCLAW_DAEMON_HOME: home });
    await mkdir(path.dirname(alpha.config), { recursive: true });
    await mkdir(path.dirname(beta.config), { recursive: true });
    await mkdir(empty.dir, { recursive: true });
    await writeFile(alpha.config, JSON.stringify({
      profile: alpha.profile,
      serverUrl: 'https://alpha.example',
      computerId: 'cmp_alpha',
      name: 'Studio Mac',
      serverName: 'Alpha Team',
      serverSlug: 'alpha-team',
      token: 'mc_machine_secret',
      createdAt: '2026-05-20T01:02:03.000Z',
      updatedAt: '2026-05-21T01:02:03.000Z',
    }, null, 2));
    await writeFile(beta.config, JSON.stringify({
      profile: beta.profile,
      serverUrl: 'https://beta.example',
      computerId: 'cmp_beta',
      name: 'Windows Desk',
      serverName: 'Beta Team',
      serverSlug: 'beta-team',
      pairToken: 'mc_pair_legacy',
    }, null, 2));

    const result = spawnSync(process.execPath, [DAEMON_BIN, 'list', '--color'], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /MagClaw Computers/);
    assert.match(result.stdout, /Computer Name/);
    assert.match(result.stdout, /Server Name/);
    assert.match(result.stdout, /Server Slug/);
    assert.match(result.stdout, /Studio Mac/);
    assert.match(result.stdout, /Alpha Team/);
    assert.match(result.stdout, /alpha-team/);
    assert.match(result.stdout, /Windows Desk/);
    assert.match(result.stdout, /2026年05月21日 09:02:03/);
    assert.match(result.stdout, /\u001b\[/);
    assert.throws(() => JSON.parse(result.stdout));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('list command keeps JSON output available for automation', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-list-json-'));
  try {
    const alpha = profilePaths('alpha server', { MAGCLAW_DAEMON_HOME: home });
    const beta = profilePaths('beta', { MAGCLAW_DAEMON_HOME: home });
    const empty = profilePaths('empty', { MAGCLAW_DAEMON_HOME: home });
    await mkdir(path.dirname(alpha.config), { recursive: true });
    await mkdir(path.dirname(beta.config), { recursive: true });
    await mkdir(empty.dir, { recursive: true });
    await writeFile(alpha.config, JSON.stringify({
      profile: alpha.profile,
      serverUrl: 'https://alpha.example',
      computerId: 'cmp_alpha',
      name: 'Studio Mac',
      serverName: 'Alpha Team',
      serverSlug: 'alpha-team',
      token: 'mc_machine_secret',
      createdAt: '2026-05-20T01:02:03.000Z',
      updatedAt: '2026-05-21T01:02:03.000Z',
    }, null, 2));
    await writeFile(beta.config, JSON.stringify({
      profile: beta.profile,
      serverUrl: 'https://beta.example',
      computerId: 'cmp_beta',
      name: 'Windows Desk',
      serverName: 'Beta Team',
      serverSlug: 'beta-team',
      pairToken: 'mc_pair_legacy',
    }, null, 2));

    const result = spawnSync(process.execPath, [DAEMON_BIN, 'list', '--json'], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.root, home);
    assert.deepEqual(payload.profiles.map((item) => item.profile), ['alpha_server', 'beta']);
    assert.deepEqual(payload.profiles.map((item) => item.computerId), ['cmp_alpha', 'cmp_beta']);
    assert.equal(payload.profiles[0].name, 'Studio Mac');
    assert.equal(payload.profiles[0].serverName, 'Alpha Team');
    assert.equal(payload.profiles[0].serverSlug, 'alpha-team');
    assert.equal(payload.profiles[0].hasMachineToken, true);
    assert.equal(payload.profiles[0].token, undefined);
    assert.equal(payload.profiles[1].hasPairToken, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('list command sorts running profiles first then by newest update time', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-list-sort-'));
  try {
    const runningOld = profilePaths('z-running-old', { MAGCLAW_DAEMON_HOME: home });
    const stoppedNew = profilePaths('b-stopped-new', { MAGCLAW_DAEMON_HOME: home });
    const stoppedOld = profilePaths('a-stopped-old', { MAGCLAW_DAEMON_HOME: home });
    for (const paths of [runningOld, stoppedNew, stoppedOld]) {
      await mkdir(path.dirname(paths.config), { recursive: true });
    }
    await mkdir(runningOld.runDir, { recursive: true });
    await writeFile(runningOld.lockFile, JSON.stringify({
      pid: process.pid,
      profile: runningOld.profile,
      startedAt: '2026-05-20T01:00:00.000Z',
    }, null, 2));
    await writeFile(runningOld.config, JSON.stringify({
      profile: runningOld.profile,
      name: 'Running Old',
      updatedAt: '2026-05-20T01:00:00.000Z',
    }, null, 2));
    await writeFile(stoppedNew.config, JSON.stringify({
      profile: stoppedNew.profile,
      name: 'Stopped New',
      updatedAt: '2026-05-25T09:00:00.000Z',
    }, null, 2));
    await writeFile(stoppedOld.config, JSON.stringify({
      profile: stoppedOld.profile,
      name: 'Stopped Old',
      updatedAt: '2026-05-24T09:00:00.000Z',
    }, null, 2));

    const result = spawnSync(process.execPath, [DAEMON_BIN, 'list', '--json'], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.profiles.map((item) => item.profile), [
      'z-running-old',
      'b-stopped-new',
      'a-stopped-old',
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('daemon upgrade dry-run accepts OpenClaw-style target aliases', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-upgrade-dry-run-'));
  try {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'upgrade',
      '--to',
      '0.1.11',
      '--dry-run',
      '--json',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.targetVersion, '0.1.11');
    assert.equal(payload.packageSpec, '@magclaw/daemon@0.1.11');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('daemon reports and verifies active background service state before remote upgrades', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');
  assert.match(source, /function backgroundServiceStatus\(/);
  assert.match(source, /const activeService = backgroundServiceStatus\(this\.paths\.profile, this\.env\)/);
  assert.match(source, /!activeService\.active/);
  assert.match(source, /const serviceStatus = backgroundServiceStatus\(this\.paths\.profile, this\.env\)/);
  assert.match(source, /function daemonServiceRunMode\(service = \{\}, serviceStatus = \{\}\)/);
  assert.match(source, /const serviceRunMode = daemonServiceRunMode\(service, serviceStatus\)/);
  assert.match(source, /active: serviceRunMode\.active/);
});

test('daemon close command stops agents and disables background relaunchers', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');

  assert.match(source, /'daemon:close'/);
  assert.match(source, /case 'daemon:close':[\s\S]*await this\.handleDaemonClose\(message\)/);
  assert.match(source, /async handleDaemonClose\(message\)/);
  assert.match(source, /for \(const session of this\.sessions\.values\(\)\) session\.stop\(\)/);
  assert.match(source, /this\.send\(\{ type: 'daemon:close:ack'/);
  assert.match(source, /writeServiceState\(this\.paths\.profile,[\s\S]*remoteClosed: true/);
  assert.match(source, /service\.remoteClosed/);
  assert.match(source, /const shouldStopBackground = Boolean\(runMode\.background\)/);
  assert.match(source, /const background = shouldStopBackground[\s\S]*stopBackground\(this\.paths\.profile, this\.env, \{ disable: message\.disableBackground !== false \}\)[\s\S]*: \{ ok: true, mode: runMode\.mode \|\| 'foreground'/);
  assert.match(source, /Foreground close request did not stop background service/);
  assert.match(source, /const serviceTarget = `gui\/\$\{process\.getuid\(\)\}\/\$\{label\}`/);
  assert.match(source, /spawnSync\('launchctl', \['disable', serviceTarget\]/);
  assert.match(source, /waitForBackgroundServiceStopped\(serviceTarget\)/);
  assert.match(source, /spawnSync\('launchctl', \['bootout', serviceTarget\]/);
  assert.match(source, /spawnSync\('launchctl', \['enable', `gui\/\$\{process\.getuid\(\)\}\/\$\{label\}`\]/);
  assert.match(source, /MAGCLAW_DAEMON_BACKGROUND_SERVICE: '1'/);
  assert.match(source, /case 'stop':[\s\S]*stopDaemon\(flags\.profile, env, \{ disable: Boolean\(flags\.disable\) \}\)/);
});

test('foreground daemon connect reports foreground mode and package metadata immediately', async () => {
  const source = await readFile(new URL('../cli-core/src/cli.js', import.meta.url), 'utf8');

  assert.match(source, /async function markForegroundServiceState\(profile = DEFAULT_PROFILE, env = process\.env\)/);
  assert.match(source, /mode: 'foreground'/);
  assert.match(source, /background: false/);
  assert.match(source, /packageName: packageInfo\.name/);
  assert.match(source, /packageVersion: packageInfo\.version/);
  assert.match(source, /async function markDaemonRunServiceState\(profile = DEFAULT_PROFILE, env = process\.env\)/);
  assert.match(source, /daemonRunLaunchedByBackgroundService\(env\)/);
  assert.match(source, /async function runForegroundDaemon\(config, env = process\.env\)[\s\S]*await markDaemonRunServiceState\(config\.profile, env\)/);
  assert.match(source, /url\.searchParams\.set\('package_name', packageName\)/);
  assert.match(source, /url\.searchParams\.set\('package_version', packageVersion\)/);
  assert.match(source, /url\.searchParams\.set\('service_mode', serviceMode\)/);
  assert.match(source, /url\.searchParams\.set\('service_background', String\(serviceBackground\)\)/);
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
    await waitForOutput(child, new RegExp(`Connecting MagClaw daemon v${regexpEscape(DAEMON_VERSION)} profile "sigint-test"`));
    child.kill('SIGINT');
    const exit = await exitPromise;
    if (process.platform === 'win32') {
      assert.equal(exit.signal, 'SIGINT');
    } else {
      assert.equal(exit.code, 130);
      assert.equal(exit.signal, null);
    }

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

test('stop command requires an explicit profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-stop-usage-'));
  try {
    const result = spawnSync(process.execPath, [DAEMON_BIN, 'stop'], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: magclaw stop --profile <name>/);
  } finally {
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
    await waitForOutput(child, new RegExp(`Connecting MagClaw daemon v${regexpEscape(DAEMON_VERSION)} profile "stop-test"`));

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

test('container background mode supervises daemon restarts and supports stop disable', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-container-'));
  const server = await startHoldingWebSocketServer();
  const env = {
    ...process.env,
    MAGCLAW_DAEMON_HOME: home,
    MAGCLAW_DAEMON_COMMAND_MODE: 'local',
    MAGCLAW_DAEMON_SERVICE_MODE: 'container',
    MAGCLAW_DAEMON_CONTAINER_RESTART_SEC: '1',
  };
  try {
    const started = spawnSync(process.execPath, [
      DAEMON_BIN,
      'connect',
      '--server-url',
      server.baseUrl,
      '--pair-token',
      'mc_pair_test',
      '--profile',
      'container-test',
      '--background',
      '--json',
    ], {
      env,
      encoding: 'utf8',
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const startPayload = JSON.parse(started.stdout);
    assert.equal(startPayload.ok, true);
    assert.equal(startPayload.mode, 'container');
    assert.ok(startPayload.supervisorPid);

    const running = await waitForDaemonStatus(env, 'container-test', (payload) => (
      payload.running
      && payload.service.mode === 'container'
      && payload.service.active
      && payload.service.status === 'running'
      && payload.service.supervisorPid
    ));
    assert.ok(running.pid);
    const serviceState = JSON.parse(await readFile(profilePaths('container-test', env).service, 'utf8'));
    assert.equal(serviceState.mode, 'container');
    assert.equal(serviceState.packageName, '@magclaw/daemon');
    assert.equal(serviceState.packageKind, 'daemon');
    assert.equal(serviceState.packageVersion, DAEMON_VERSION);
    assert.equal(serviceState.packageSpec, `@magclaw/daemon@${DAEMON_VERSION}`);

    process.kill(running.pid, 'SIGTERM');
    const restarted = await waitForDaemonStatus(env, 'container-test', (payload) => (
      payload.running
      && payload.pid
      && payload.pid !== running.pid
      && payload.service.mode === 'container'
    ), 8000);
    assert.ok(restarted.pid);

    const stopped = spawnSync(process.execPath, [
      DAEMON_BIN,
      'stop',
      '--profile',
      'container-test',
      '--disable',
    ], {
      env,
      encoding: 'utf8',
    });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    const stoppedPayload = JSON.parse(stopped.stdout);
    assert.equal(stoppedPayload.ok, true);
    assert.equal(stoppedPayload.background.mode, 'container');

    await waitForDaemonStatus(env, 'container-test', (payload) => (
      !payload.running && !payload.service.active
    ));
  } finally {
    spawnSync(process.execPath, [
      DAEMON_BIN,
      'stop',
      '--profile',
      'container-test',
      '--disable',
    ], {
      env,
      encoding: 'utf8',
    });
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
