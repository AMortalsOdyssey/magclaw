import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function exists(target) {
  return stat(target).then(() => true).catch(() => false);
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function verifyPluginTree(root) {
  const [installation, manifest, source] = await Promise.all([
    readFile(path.join(root, 'installation.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'openclaw.plugin.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'index.js')),
  ]);
  const actual = crypto.createHash('sha256').update(source).digest('hex');
  if (!installation.sha256 || actual !== installation.sha256) throw new Error('Bundled MagClaw Notify plugin checksum verification failed.');
  const entryId = /definePluginEntry\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(String(source))?.[1] || '';
  if (!manifest.id || !entryId || manifest.id !== entryId) throw new Error(`OpenClaw plugin id mismatch: manifest=${manifest.id || 'missing'} entry=${entryId || 'missing'}.`);
  return { installation, manifest, sha256: actual };
}

export async function installNotifyOpenClawPlugin(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const source = path.join(packageRoot, 'dist', 'openclaw-plugin');
  if (!await exists(path.join(source, 'index.js'))) {
    throw new Error('The MagClaw Notify Owner package is missing its bundled OpenClaw plugin. Reinstall @magclaw/notify-owner from npm.');
  }

  const target = path.resolve(options.target || path.join(os.homedir(), '.openclaw', 'plugins', 'magclaw-notify'));
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, '.magclaw-notify-plugin-'));
  const backup = `${target}.previous`;
  let backedUp = false;

  try {
    await copyTree(source, staging);
    const verified = await verifyPluginTree(staging);
    const installation = verified.installation;
    installation.installedAt = new Date().toISOString();
    await writeFile(path.join(staging, 'installation.json'), `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });
    await rm(backup, { recursive: true, force: true });
    if (await exists(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(staging, target);
    await verifyPluginTree(target);
    return { ok: true, pluginPath: target, version: installation.version, sha256: installation.sha256 };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !await exists(target)) await rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function rollbackNotifyOpenClawPlugin(options = {}) {
  const target = path.resolve(options.target || path.join(os.homedir(), '.openclaw', 'plugins', 'magclaw-notify'));
  const backup = `${target}.previous`;
  if (!await exists(backup)) throw new Error('No previous MagClaw Notify plugin backup is available.');
  const verified = await verifyPluginTree(backup);
  const failed = `${target}.failed-${Date.now()}`;
  if (await exists(target)) await rename(target, failed);
  try {
    await rename(backup, target);
    await rm(failed, { recursive: true, force: true }).catch(() => {});
    return { ok: true, rolledBack: true, pluginPath: target, version: verified.installation.version, sha256: verified.sha256 };
  } catch (error) {
    if (await exists(failed) && !await exists(target)) await rename(failed, target).catch(() => {});
    throw error;
  }
}
