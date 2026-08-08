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
    const installation = JSON.parse(await readFile(path.join(staging, 'installation.json'), 'utf8'));
    installation.installedAt = new Date().toISOString();
    await writeFile(path.join(staging, 'installation.json'), `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });
    await rm(backup, { recursive: true, force: true });
    if (await exists(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(staging, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return { ok: true, pluginPath: target, version: installation.version, sha256: installation.sha256 };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !await exists(target)) await rename(backup, target).catch(() => {});
    throw error;
  }
}
