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

  const webPackage = await readJson('web/package.json');
  assert.equal(webPackage.name, '@magclaw/web');
  assert.equal(webPackage.scripts.start, 'node ../server/index.js');

  const daemonPackage = await readJson('daemon/package.json');
  assert.equal(daemonPackage.name, '@magclaw/daemon');
  assert.deepEqual(daemonPackage.files, ['bin/', 'src/', 'README.md']);
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

test('top-level daemon package is self-contained as an npm artifact', () => {
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
});
