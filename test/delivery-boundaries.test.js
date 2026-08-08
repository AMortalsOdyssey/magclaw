import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
}

test('root exposes separate web service and daemon delivery scripts', async () => {
  const rootPackage = await readJson('package.json');
  assert.equal(rootPackage.scripts['web:start'], 'node server/index.js');
  assert.equal(rootPackage.scripts['web:docker:build'], 'docker build -f web/Dockerfile -t magclaw-web .');
  assert.equal(rootPackage.scripts['daemon:pack'], 'npm pack --dry-run --json ./daemon');
  assert.equal(rootPackage.scripts['notify:pack'], 'npm pack --dry-run --json ./notify');
  assert.equal(rootPackage.scripts['notify-owner:pack'], 'npm pack --dry-run --json ./notify-owner');

  const webPackage = await readJson('web/package.json');
  assert.equal(webPackage.name, '@magclaw/web');
  assert.equal(webPackage.scripts.start, 'node ../server/index.js');

  const daemonPackage = await readJson('daemon/package.json');
  assert.equal(daemonPackage.name, '@magclaw/daemon');
  assert.deepEqual(daemonPackage.files, ['bin/', 'RELEASE_NOTES.md', 'README.md']);

  const cliCorePackage = await readJson('cli-core/package.json');
  assert.equal(cliCorePackage.name, '@magclaw/cli-core');
  assert.deepEqual(cliCorePackage.files, ['bin/', 'src/', 'skills/', 'RELEASE_NOTES.md', 'README.md']);

  const notifyPackage = await readJson('notify/package.json');
  assert.equal(notifyPackage.name, '@magclaw/notify');
  assert.equal(notifyPackage.publishConfig.access, 'public');
  assert.deepEqual(notifyPackage.files, ['bin/', 'src/audit.js', 'src/cli.js', 'src/mcp.js', 'src/summary.js', 'skills/magclaw-notify/', 'RELEASE_NOTES.md', 'README.md']);

  const notifyOwnerPackage = await readJson('notify-owner/package.json');
  assert.equal(notifyOwnerPackage.name, '@magclaw/notify-owner');
  assert.equal(notifyOwnerPackage.publishConfig.access, 'public');
  assert.equal(notifyOwnerPackage.bin['magclaw-notify-owner'], 'bin/magclaw-notify-owner.js');
  assert.equal(notifyOwnerPackage.exports['.'], './dist/owner.js');
  const notifyOwnerSource = await readFile(path.join(ROOT, 'notify-owner/src/owner.js'), 'utf8');
  assert.match(notifyOwnerSource, /bin', 'magclaw-notify-owner\.js'/);
});

test('web Dockerfile builds the cloud service boundary and upload mount target', async () => {
  const dockerfile = await readFile(path.join(ROOT, 'web/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY server \.\/server/);
  assert.match(dockerfile, /COPY public \.\/public/);
  assert.match(dockerfile, /COPY shared \.\/shared/);
  assert.match(dockerfile, /MAGCLAW_UPLOAD_DIR=\/var\/lib\/magclaw\/uploads/);
  assert.match(dockerfile, /CMD \["node", "server\/index\.js"\]/);
});

test('shared route constants pin Console and Server URL surfaces', async () => {
  const routes = await import('../shared/routes.js');
  assert.equal(routes.CONSOLE_ROUTES.root, '/console');
  assert.equal(routes.CONSOLE_ROUTES.invitations, '/console/invitations');
  assert.equal(routes.CONSOLE_ROUTES.servers, '/console/servers');
  assert.equal(routes.serverRoute('secondTeam', 'channels/chan_all'), '/s/secondTeam/channels/chan_all');
  assert.equal(
    routes.consoleInvitationActionRoute('inv 1', 'accept'),
    '/api/console/invitations/inv%201/accept',
  );
});

test('top-level daemon package is a thin npm artifact over CLI core', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', './daemon'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/magclaw-delivery-boundaries-cache', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw-daemon.js'));
  assert.equal(files.some((file) => file.startsWith('src/')), false);
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.startsWith('public/')), false);
  assert.equal(files.some((file) => file.startsWith('web/')), false);
  assert.equal(files.some((file) => file.startsWith('shared/')), false);
});

test('Notify package includes sender CLI, MCP tools, structured protocol, and explicit Skill assets only', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', './notify'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/magclaw-delivery-boundaries-cache', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/magclaw-notify.js'));
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/mcp.js'));
  assert.ok(files.includes('src/summary.js'));
  assert.ok(files.includes('skills/magclaw-notify/SKILL.md'));
  assert.ok(files.includes('skills/magclaw-notify/references/summary-templates.md'));
  assert.equal(files.some((file) => /src\/(?:daemon|handler|service|executable|instance)\.js$/.test(file)), false);
  assert.equal(files.some((file) => file.includes('magclaw-notify-handler')), false);
  assert.equal(files.some((file) => file.startsWith('server/')), false);
  assert.equal(files.some((file) => file.includes('config.json')), false);
});

test('Notify Owner package ships an installable CLI and fixed OpenClaw bundle without repository source or runtime state', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', './notify-owner'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/magclaw-delivery-boundaries-cache', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  for (const required of [
    'bin/magclaw-notify-owner.js',
    'dist/owner.js',
    'dist/plugin-installer.js',
    'dist/openclaw-plugin/index.js',
    'dist/openclaw-plugin/openclaw.plugin.json',
    'dist/openclaw-plugin/installation.json',
  ]) assert.ok(files.includes(required), `missing ${required}`);
  assert.equal(files.some((file) => file.startsWith('src/')), false);
  assert.equal(files.some((file) => file.startsWith('openclaw-plugin/')), false);
  assert.equal(files.some((file) => /(?:config|state|audit)\.(?:json|jsonl|db)$/.test(file)), false);
});

test('No sender or unrelated public package ships owner-side Notify implementation or Skills', () => {
  for (const pkg of ['./cli-core', './daemon', './computer', './team-sharing', './notify']) {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', pkg], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/magclaw-delivery-boundaries-cache', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    assert.equal(result.status, 0, `${pkg}: ${result.stderr || result.stdout}`);
    const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
    assert.equal(
      files.some((file) => file.includes('magclaw-notify-handler')),
      false,
      `${pkg} must not ship the owner Notify handler Skill or command`,
    );
    assert.equal(
      files.some((file) => /notify-handler\.js$/.test(file)),
      false,
      `${pkg} must not ship an owner Notify handler implementation`,
    );
  }
});

test('cloud runtime images include the shared Notify summary protocol module', async () => {
  for (const file of ['Dockerfile', 'web/Dockerfile']) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    assert.match(source, /COPY notify\/src\/summary\.js \.\/notify\/src\/summary\.js/);
    assert.match(source, /COPY notify\/src\/audit\.js \.\/notify\/src\/audit\.js/);
    assert.match(source, /COPY notify-owner\/src\/instance\.js \.\/notify-owner\/src\/instance\.js/);
  }
});

test('team-sharing package includes install-time plugin bundle and hook templates', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', './team-sharing'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: '/tmp/magclaw-delivery-boundaries-cache', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('bin/team-sharing.js'));
  assert.ok(files.includes('src/team-sharing.js'));
  assert.ok(files.includes('codex-plugin/.codex-plugin/plugin.json'));
  for (const skill of ['setup', 'session-reporting', 'search', 'read-link', 'share-artifact', 'edit-link', 'manage-links']) {
    assert.ok(files.includes(`codex-plugin/skills/${skill}/SKILL.md`));
  }
  assert.ok(files.includes('codex-plugin/skills/search/references/answer-style.md'));
  assert.ok(files.includes('codex-plugin/skills/share-artifact/references/default-html-style.md'));
  assert.ok(files.includes('hooks/codex-hooks.json.template'));
  assert.ok(files.includes('hooks/claude-settings.local.json.template'));
  assert.equal(files.some((file) => file.startsWith('skills/')), false);
  assert.equal(files.some((file) => file.startsWith('.agents/')), false);
  assert.equal(files.some((file) => file.startsWith('.claude/')), false);
  assert.equal(files.some((file) => file.startsWith('.codex/')), false);
});
