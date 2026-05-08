import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectRuntimes,
  ensureMachineFingerprint,
  parseCli,
  profilePaths,
} from '../daemon/src/cli.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

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
  });
  const codex = runtimes.find((runtime) => runtime.id === 'codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.appServer, true);
  assert.match(codex.version, /9\.9\.9/);
  assert.equal(runtimes.find((runtime) => runtime.id === 'claude-code').installed, false);
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
