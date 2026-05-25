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
  runtimeCommandHasPathSeparator,
  runtimeCommandNeedsShell,
  selectRuntimeCommandPath,
  toWebSocketUrl,
  windowsNpmShimScript,
} from '../daemon/src/cli.js';

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

test('daemon version and foreground log lines are structured', () => {
  assert.equal(DAEMON_VERSION, '0.1.19');
  assert.equal(
    formatDaemonLogLine('info', 'daemon', 'MagClaw daemon ready.', new Date(2026, 4, 14, 8, 9, 10)),
    '2026-05-14 08:09:10 INFO DAEMON MagClaw daemon ready.',
  );
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
  const daemonSource = await readFile(new URL('../daemon/src/cli.js', import.meta.url), 'utf8');
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
  assert.match(daemonSource, /MAGCLAW_DAEMON_RECONNECT_MAX_MS/);
  assert.match(daemonSource, /agent:activity_probe/);
  assert.match(daemonSource, /handleAgentActivityProbe\(message\)/);
  assert.match(relaySource, /case 'heartbeat':/);
  assert.match(relaySource, /MAGCLAW_DAEMON_PING_MS/);
  assert.match(relaySource, /MAGCLAW_DAEMON_ACTIVITY_PROBE_TIMEOUT_MS/);
  assert.match(relaySource, /DEFAULT_DAEMON_RECONNECT_GRACE_MS = readMsEnv\('MAGCLAW_DAEMON_RECONNECT_GRACE_MS', 60_000, \{ min: 0, max: 5 \* 60_000 \}\)/);
  assert.match(relaySource, /startConnectionPing\(connection\)/);
  assert.match(relaySource, /probeStaleAgentHeartbeats\(\)/);
  assert.match(relaySource, /case 'pong':/);
  assert.match(relaySource, /computer\.status = 'connected'/);
});

test('daemon agent starts and stream activity use Slock-style bounded scheduling', async () => {
  const daemonSource = await readFile(new URL('../daemon/src/cli.js', import.meta.url), 'utf8');
  const mcpBridgeSource = await readFile(new URL('../daemon/src/mcp-bridge.js', import.meta.url), 'utf8');

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
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/list-renderer.js'));
  assert.ok(files.includes('src/mcp-bridge.js'));
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.some((file) => file.startsWith('shared/')), false);
  assert.equal(files.includes('Dockerfile'), false);
  assert.equal(files.includes('kizuna.json'), false);
});

test('computer npm package is a thin setup wrapper around the daemon package', async () => {
  const computerPackage = JSON.parse(await readFile(new URL('../computer/package.json', import.meta.url), 'utf8'));
  const computerBin = await readFile(new URL('../computer/bin/magclaw-computer.js', import.meta.url), 'utf8');

  assert.equal(computerPackage.name, '@magclaw/computer');
  assert.equal(computerPackage.version, DAEMON_VERSION);
  assert.deepEqual(computerPackage.bin, { 'magclaw-computer': 'bin/magclaw-computer.js' });
  assert.equal(computerPackage.dependencies['@magclaw/daemon'], DAEMON_VERSION);
  assert.match(computerBin, /@magclaw\/daemon\/src\/cli\.js/);
  assert.match(computerBin, /args\[0\] === 'computer' \? args : \['computer', \.\.\.args\]/);

  const help = spawnSync(process.execPath, [COMPUTER_BIN, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage: magclaw/);
  assert.match(help.stdout, /computer\s+Pair this local computer with a server using browser approval/);
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
  assert.deepEqual(daemonPackage.bin, { magclaw: 'bin/magclaw.js' });
  assert.ok(CAPABILITIES.includes('daemon:upgrade'));
});

test('daemon renders durable magclaw CLI shims for macOS Linux and Windows', () => {
  const macFiles = renderCliShimFiles({
    platform: 'darwin',
    npmPath: '/opt/homebrew/bin/npm',
    packageSpec: '@magclaw/daemon@latest',
  });
  assert.deepEqual(macFiles.map((file) => file.name), ['magclaw']);
  assert.match(macFiles[0].content, /^#!\/bin\/sh/);
  assert.match(macFiles[0].content, /@magclaw\/daemon@latest/);
  assert.match(macFiles[0].content, /exec "\$NPM_BIN" exec --yes --package "\$PACKAGE_SPEC" -- magclaw "\$@"/);

  const linuxFiles = renderCliShimFiles({
    platform: 'linux',
    npmPath: '/usr/bin/npm',
    packageSpec: '@magclaw/daemon@latest',
  });
  assert.deepEqual(linuxFiles.map((file) => file.name), ['magclaw']);
  assert.match(linuxFiles[0].content, /NPM_BIN='\/usr\/bin\/npm'/);

  const windowsFiles = renderCliShimFiles({
    platform: 'win32',
    npmPath: 'C:\\Users\\tt\\AppData\\Roaming\\npm\\npm.cmd',
    packageSpec: '@magclaw/daemon@latest',
  });
  assert.deepEqual(windowsFiles.map((file) => file.name), ['magclaw.cmd', 'magclaw.ps1']);
  assert.match(windowsFiles[0].content, /@echo off/);
  assert.match(windowsFiles[0].content, /@magclaw\/daemon@latest/);
  assert.match(windowsFiles[0].content, /%ARGS%/);
  assert.match(windowsFiles[1].content, /@args/);
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

test('install-cli command writes a durable magclaw command shim', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-home-'));
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cli-bin-'));
  try {
    const result = spawnSync(process.execPath, [
      DAEMON_BIN,
      'install-cli',
      '--bin-dir',
      binDir,
      '--package-spec',
      '@magclaw/daemon@latest',
    ], {
      env: { ...process.env, MAGCLAW_DAEMON_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'magclaw');
    assert.equal(payload.installed, true);
    assert.equal(payload.pathReady, true);
    assert.ok(payload.files.length >= 1);

    const files = await readdir(binDir);
    if (process.platform === 'win32') {
      assert.ok(files.includes('magclaw.cmd'));
      assert.ok(files.includes('magclaw.ps1'));
    } else {
      assert.deepEqual(files, ['magclaw']);
      const shim = await readFile(path.join(binDir, 'magclaw'), 'utf8');
      assert.match(shim, /exec "\$NPM_BIN" exec/);
      assert.match(shim, /@magclaw\/daemon@latest/);
    }
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
  const source = await readFile(new URL('../daemon/src/cli.js', import.meta.url), 'utf8');
  assert.match(source, /function backgroundServiceStatus\(/);
  assert.match(source, /const activeService = backgroundServiceStatus\(this\.paths\.profile, this\.env\)/);
  assert.match(source, /!activeService\.active/);
  assert.match(source, /const serviceStatus = backgroundServiceStatus\(this\.paths\.profile, this\.env\)/);
  assert.match(source, /active: Boolean\(serviceStatus\.active\)/);
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
