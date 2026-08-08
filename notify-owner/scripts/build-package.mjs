import crypto from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(packageRoot, 'dist');
const pluginSource = path.join(packageRoot, 'openclaw-plugin');
const pluginDist = path.join(distRoot, 'openclaw-plugin');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const pluginManifest = JSON.parse(await readFile(path.join(pluginSource, 'openclaw.plugin.json'), 'utf8'));
const pluginSourceText = await readFile(path.join(pluginSource, 'index.js'), 'utf8');
const entryId = /definePluginEntry\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(pluginSourceText)?.[1] || '';

if (!entryId || entryId !== pluginManifest.id) {
  throw new Error(`OpenClaw plugin id mismatch: manifest=${pluginManifest.id || 'missing'} entry=${entryId || 'missing'}.`);
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(pluginDist, { recursive: true });

await build({
  entryPoints: [path.join(packageRoot, 'src', 'owner.js')],
  outfile: path.join(distRoot, 'owner.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.5',
  external: ['undici', 'ws'],
  legalComments: 'none',
  sourcemap: false,
});

await build({
  entryPoints: [path.join(packageRoot, 'src', 'plugin-installer.js')],
  outfile: path.join(distRoot, 'plugin-installer.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.5',
  legalComments: 'none',
  sourcemap: false,
});

await build({
  entryPoints: [path.join(pluginSource, 'index.js')],
  outfile: path.join(pluginDist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  external: ['openclaw/*'],
  legalComments: 'none',
  sourcemap: false,
});

await copyFile(path.join(pluginSource, 'openclaw.plugin.json'), path.join(pluginDist, 'openclaw.plugin.json'));
await writeFile(path.join(pluginDist, 'package.json'), `${JSON.stringify({
  name: '@magclaw/openclaw-notify',
  version: packageJson.version,
  private: true,
  type: 'module',
  openclaw: { extensions: ['./index.js'] },
}, null, 2)}\n`, { mode: 0o600 });
const bundle = await readFile(path.join(pluginDist, 'index.js'));
await writeFile(path.join(pluginDist, 'installation.json'), `${JSON.stringify({
  format: 'bundled-fixed-copy-v2',
  version: packageJson.version,
  sha256: crypto.createHash('sha256').update(bundle).digest('hex'),
}, null, 2)}\n`, { mode: 0o600 });

process.stderr.write(`[notify-owner] built ${packageJson.name}@${packageJson.version} at ${distRoot}\n`);
