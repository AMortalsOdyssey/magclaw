import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { listNotifyBindings, notifyBindingProfile } from './bindings.js';
import { installNotifyOpenClawPlugin, rollbackNotifyOpenClawPlugin } from './plugin-installer.js';
import { closeNotifyStateStore, ensureNotifyStateStore } from './store.js';

export const NOTIFY_OWNER_PACKAGE_NAME = '@magclaw/notify-owner';
export const NOTIFY_OWNER_UPDATE_TTL_MS = 6 * 60 * 60_000;

function root(env = process.env) {
  const home = path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
  return path.join(home, 'updates', 'owner');
}

export function notifyOwnerUpdatePaths(env = process.env) {
  const dir = root(env);
  return { root: dir, state: path.join(dir, 'state.json'), backup: path.join(dir, 'state.json.bak'), lock: path.join(dir, 'lock'), log: path.join(dir, 'update.log') };
}

function semver(value = '') {
  const match = String(value).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''] : null;
}

export function notifyOwnerVersionGreater(candidate, current) {
  const a = semver(candidate); const b = semver(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return Boolean(!a[3] && b[3]);
}

async function atomic(file, value, backup = true) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const existed = await stat(file).then(() => true).catch(() => false);
    if (backup && existed) await writeFile(`${file}.bak`, await readFile(file), { mode: 0o600 });
    await rename(tmp, file); await chmod(file, 0o600).catch(() => {});
    if (backup && !existed) await writeFile(`${file}.bak`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
}

export async function readNotifyOwnerUpdateState(env = process.env) {
  const paths = notifyOwnerUpdatePaths(env);
  try { return JSON.parse(await readFile(paths.state, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1 };
    try {
      const backup = JSON.parse(await readFile(paths.backup, 'utf8'));
      await atomic(paths.state, { ...backup, recoveredAt: new Date().toISOString() }, false);
      return { ...backup, recoveredFromBackup: true };
    } catch { return { version: 1, stateError: 'invalid_update_state' }; }
  }
}

async function log(paths, event, metadata = {}) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const safe = Object.fromEntries(Object.entries(metadata).filter(([key]) => !/token|secret|password|path/i.test(key)));
  await writeFile(paths.log, `${JSON.stringify({ at: new Date().toISOString(), event, ...safe })}\n`, { flag: 'a', mode: 0o600 });
}

async function lock(paths) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try { await mkdir(paths.lock, { mode: 0o700 }); await writeFile(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 }); return { acquired: true, release: () => rm(paths.lock, { recursive: true, force: true }) }; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = await readFile(path.join(paths.lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const lockTimestamp = Number(owner.at || await stat(paths.lock).then((info) => info.mtimeMs).catch(() => Date.now()));
    if (Date.now() - lockTimestamp > 30 * 60_000) { await rm(paths.lock, { recursive: true, force: true }); return lock(paths); }
    return { acquired: false, release: async () => {} };
  }
}

export async function notifyOwnerIsIdle(env = process.env) {
  const { bindings } = await listNotifyBindings(env);
  const busy = [];
  for (const binding of bindings) {
    const profile = notifyBindingProfile(binding, env);
    const store = await ensureNotifyStateStore(profile.handler);
    try {
      const pending = store.read('pending', 'state', []);
      const intents = store.dump().deliveryIntents || [];
      const activeConfirmations = Array.isArray(pending) ? pending.filter((item) => item?.status === 'pending').length : 0;
      const activeDeliveries = intents.filter((item) => ['prepared', 'sending', 'sent_unconfirmed'].includes(item?.status)).length;
      if (activeConfirmations || activeDeliveries) busy.push({ bot: binding.id, activeConfirmations, activeDeliveries });
    } finally { closeNotifyStateStore(profile.handler); }
  }
  return { idle: busy.length === 0, busy };
}

export async function checkNotifyOwnerUpdate(currentVersion, options = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 5_000)); timer.unref?.();
  try {
    const response = await (options.fetch || fetch)('https://registry.npmjs.org/@magclaw%2fnotify-owner/latest', { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const latestVersion = String((await response.json()).version || '');
    return { ok: true, currentVersion, latestVersion, updateAvailable: notifyOwnerVersionGreater(latestVersion, currentVersion), checkedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}

function run(command, args, env) { return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } }); }

export async function applyNotifyOwnerUpdate(targetVersion, options = {}, env = process.env) {
  const version = String(targetVersion || '').trim(); if (!semver(version)) throw new Error('A valid Notify Owner target version is required.');
  const paths = notifyOwnerUpdatePaths(env); const updateLock = await lock(paths);
  if (!updateLock.acquired) return { ok: true, skipped: true, reason: 'update_in_progress' };
  const previous = await readNotifyOwnerUpdateState(env); const npm = String(options.npmPath || env.MAGCLAW_NOTIFY_NPM_PATH || 'npm');
  if (previous.activeVersion === version) { await updateLock.release(); return { ok: true, skipped: true, reason: 'already_current', currentVersion: version }; }
  let packageInstalled = false;
  let pluginInstalled = false;
  try {
    await log(paths, 'owner.update.started', { targetVersion: version });
    const install = run(npm, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${NOTIFY_OWNER_PACKAGE_NAME}@${version}`], env);
    if (install.status !== 0) throw new Error(String(install.stderr || install.stdout || `npm exited ${install.status}`).trim());
    packageInstalled = true;
    const verify = run(npm, ['exec', '--yes', `--package=${NOTIFY_OWNER_PACKAGE_NAME}@${version}`, '--', 'magclaw-notify-owner', '--version'], env);
    if (verify.status !== 0 || String(verify.stdout || '').trim() !== version) throw new Error(`Installed Notify Owner ${version} failed verification.`);
    const plugin = run(npm, ['exec', '--yes', `--package=${NOTIFY_OWNER_PACKAGE_NAME}@${version}`, '--', 'magclaw-notify-owner', 'install'], env);
    if (plugin.status !== 0) throw new Error(String(plugin.stderr || plugin.stdout || 'Notify plugin installation failed.').trim());
    pluginInstalled = true;
    const idle = await notifyOwnerIsIdle(env);
    let restarted = false;
    if (idle.idle && options.restart !== false) {
      const restart = run(options.openclawPath || 'openclaw', ['gateway', 'restart'], env);
      if (restart.status !== 0) throw new Error(String(restart.stderr || restart.stdout || 'OpenClaw restart failed.').trim());
      restarted = true;
    }
    const state = { version: 1, activeVersion: version, previousVersion: previous.activeVersion || options.currentVersion || '', pendingRestart: !restarted, lastCheckAt: new Date().toISOString(), lastUpdate: { ok: true, version, restarted, at: new Date().toISOString() } };
    await atomic(paths.state, state); await log(paths, 'owner.update.succeeded', { targetVersion: version, restarted });
    return { ok: true, updated: true, currentVersion: version, previousVersion: state.previousVersion, restarted, deferredForBusyState: !idle.idle, busy: idle.busy };
  } catch (error) {
    let pluginRolledBack = false;
    let packageRolledBack = false;
    if (pluginInstalled) pluginRolledBack = await rollbackNotifyOpenClawPlugin({ target: options.pluginPath }).then(() => true).catch(() => false);
    if (packageInstalled && semver(previous.activeVersion || options.currentVersion || '')) {
      const rollbackVersion = previous.activeVersion || options.currentVersion;
      packageRolledBack = run(npm, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${NOTIFY_OWNER_PACKAGE_NAME}@${rollbackVersion}`], env).status === 0;
    }
    await atomic(paths.state, { ...previous, lastUpdate: { ok: false, targetVersion: version, error: String(error.message).slice(0, 500), pluginRolledBack, packageRolledBack, at: new Date().toISOString() } });
    await log(paths, 'owner.update.failed', { targetVersion: version, error: String(error.message).slice(0, 300) }); throw error;
  } finally { await updateLock.release(); }
}

export async function rollbackNotifyOwnerUpdate(options = {}, env = process.env) {
  const state = await readNotifyOwnerUpdateState(env);
  const plugin = await rollbackNotifyOpenClawPlugin({ target: options.pluginPath });
  if (options.restart !== false) {
    const restarted = run(options.openclawPath || 'openclaw', ['gateway', 'restart'], env);
    if (restarted.status !== 0) throw new Error(String(restarted.stderr || restarted.stdout || 'OpenClaw restart failed.').trim());
  }
  await atomic(notifyOwnerUpdatePaths(env).state, { ...state, activeVersion: plugin.version, previousVersion: state.activeVersion || '', pendingRestart: false, lastRollback: { ok: true, version: plugin.version, at: new Date().toISOString() } });
  return { ...plugin, restarted: options.restart !== false };
}

export async function runNotifyOwnerBackgroundUpdate(currentVersion, options = {}, env = process.env) {
  const paths = notifyOwnerUpdatePaths(env); const state = await readNotifyOwnerUpdateState(env);
  if (state.pendingRestart) {
    const idle = await notifyOwnerIsIdle(env);
    if (idle.idle) {
      const restarted = run(options.openclawPath || 'openclaw', ['gateway', 'restart'], env);
      if (restarted.status === 0) { await atomic(paths.state, { ...state, pendingRestart: false, restartedAt: new Date().toISOString() }); return { ok: true, restarted: true }; }
    }
  }
  const last = Date.parse(state.lastCheckAt || '');
  if (!options.force && Number.isFinite(last) && Date.now() - last < NOTIFY_OWNER_UPDATE_TTL_MS) return { ok: true, skipped: true, reason: 'fresh' };
  let check;
  try { check = await checkNotifyOwnerUpdate(currentVersion, options); }
  catch (error) { await atomic(paths.state, { ...state, lastCheckAt: new Date().toISOString(), lastCheck: { ok: false, error: String(error.message).slice(0, 500) } }); await log(paths, 'owner.update.check_failed', { error: String(error.message).slice(0, 300) }); return { ok: false, error: error.message }; }
  await atomic(paths.state, { ...state, lastCheckAt: check.checkedAt, lastCheck: check });
  return check.updateAvailable ? applyNotifyOwnerUpdate(check.latestVersion, { ...options, currentVersion }, env) : { ...check, updated: false };
}

export function scheduleNotifyOwnerBackgroundUpdate(currentVersion, options = {}, env = process.env) {
  if (env.MAGCLAW_NOTIFY_OWNER_AUTO_UPDATE === '0' || options.disabled) return { scheduled: false, reason: 'auto_update_disabled' };
  const paths = notifyOwnerUpdatePaths(env);
  try {
    const state = JSON.parse(readFileSync(paths.state, 'utf8'));
    const last = Date.parse(state.lastCheckAt || '');
    if (!state.pendingRestart && Number.isFinite(last) && Date.now() - last < NOTIFY_OWNER_UPDATE_TTL_MS) return { scheduled: false, reason: 'fresh' };
  } catch {}
  const npm = String(options.npmPath || env.MAGCLAW_NOTIFY_NPM_PATH || 'npm');
  const timer = setTimeout(() => {
    const child = spawn(npm, ['exec', '--yes', `--package=${NOTIFY_OWNER_PACKAGE_NAME}@latest`, '--', 'magclaw-notify-owner', 'update', 'background-check', '--current-version', currentVersion], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env, MAGCLAW_NOTIFY_OWNER_UPDATE_CHILD: '1' } });
    child.unref();
  }, Number(options.delayMs || 60_000));
  timer.unref?.();
  return { scheduled: true };
}
