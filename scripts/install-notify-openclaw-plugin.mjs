import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'notify-daemon', 'openclaw-plugin');

function flag(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = path.resolve(flag('target', path.join(os.homedir(), '.openclaw', 'plugins', 'magclaw-notify')));
const parent = path.dirname(target);
await mkdir(parent, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(path.join(parent, '.magclaw-notify-plugin-'));
const backup = `${target}.previous`;
let backedUp = false;

try {
  await build({
    entryPoints: [path.join(sourceRoot, 'index.js')],
    outfile: path.join(staging, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.19',
    external: ['openclaw/*'],
    legalComments: 'none',
    sourcemap: false,
  });
  await copyFile(path.join(sourceRoot, 'openclaw.plugin.json'), path.join(staging, 'openclaw.plugin.json'));
  const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  await writeFile(path.join(staging, 'package.json'), `${JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: 'module',
    openclaw: { extensions: ['./index.js'] },
  }, null, 2)}\n`, { mode: 0o600 });
  const bundle = await readFile(path.join(staging, 'index.js'));
  await writeFile(path.join(staging, 'installation.json'), `${JSON.stringify({
    format: 'bundled-fixed-copy-v1',
    version: sourcePackage.version,
    sha256: crypto.createHash('sha256').update(bundle).digest('hex'),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  await rm(backup, { recursive: true, force: true });
  if (await stat(target).then(() => true).catch(() => false)) {
    await rename(target, backup);
    backedUp = true;
  }
  await rename(staging, target);
  if (backedUp) await rm(backup, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ok: true, pluginPath: target, version: sourcePackage.version })}\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  if (backedUp && !await stat(target).then(() => true).catch(() => false)) await rename(backup, target).catch(() => {});
  throw error;
}
