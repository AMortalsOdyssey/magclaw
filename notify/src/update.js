import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTIFY_PACKAGE_NAME = '@magclaw/notify';
export const NOTIFY_UPDATE_TTL_MS = 6 * 60 * 60_000;

function updateRoot(env = process.env) {
  const home = path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
  return path.join(home, 'updates', 'client');
}

export function notifyUpdatePaths(env = process.env) {
  const root = updateRoot(env);
  return { root, state: path.join(root, 'state.json'), backup: path.join(root, 'state.json.bak'), lock: path.join(root, 'lock'), log: path.join(root, 'update.log') };
}

function parts(version = '') {
  const match = String(version).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ''] : null;
}

export function notifyVersionGreater(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  if (a[3] === b[3]) return false;
  if (!a[3]) return true;
  if (!b[3]) return false;
  return a[3].localeCompare(b[3], undefined, { numeric: true }) > 0;
}

async function writeAtomic(file, value, backup = true) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const existed = await stat(file).then(() => true).catch(() => false);
    if (backup && existed) await writeFile(`${file}.bak`, await readFile(file), { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
    if (backup && !existed) await writeFile(`${file}.bak`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readNotifyUpdateState(env = process.env) {
  const paths = notifyUpdatePaths(env);
  try { return JSON.parse(await readFile(paths.state, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1 };
    try {
      const backup = JSON.parse(await readFile(paths.backup, 'utf8'));
      await writeAtomic(paths.state, { ...backup, recoveredAt: new Date().toISOString() }, false);
      return { ...backup, recoveredFromBackup: true };
    } catch { return { version: 1, stateError: 'invalid_update_state' }; }
  }
}

async function appendLog(paths, event, metadata = {}) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const safe = Object.fromEntries(Object.entries(metadata).filter(([key]) => !/token|secret|password|path/i.test(key)));
  await writeFile(paths.log, `${JSON.stringify({ at: new Date().toISOString(), event, ...safe })}\n`, { mode: 0o600, flag: 'a' });
  await chmod(paths.log, 0o600).catch(() => {});
}

async function acquireLock(paths) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try {
    await mkdir(paths.lock, { mode: 0o700 });
    await writeFile(path.join(paths.lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 });
    return { acquired: true, release: () => rm(paths.lock, { recursive: true, force: true }) };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = await readFile(path.join(paths.lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const lockTimestamp = Number(owner.at || await stat(paths.lock).then((info) => info.mtimeMs).catch(() => Date.now()));
    if (Date.now() - lockTimestamp > 30 * 60_000) {
      await rm(paths.lock, { recursive: true, force: true });
      return acquireLock(paths);
    }
    return { acquired: false, release: async () => {} };
  }
}

export async function checkNotifyUpdate(options = {}, env = process.env) {
  const currentVersion = String(options.currentVersion || '0.0.0');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 5_000));
  timer.unref?.();
  try {
    const request = options.fetch || fetch;
    const response = await request('https://registry.npmjs.org/@magclaw%2fnotify/latest', { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const data = await response.json();
    const latestVersion = String(data.version || '');
    return { ok: true, currentVersion, latestVersion, updateAvailable: notifyVersionGreater(latestVersion, currentVersion), checkedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}

function run(command, args, env) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
}

export async function applyNotifyUpdate(targetVersion, options = {}, env = process.env) {
  const version = String(targetVersion || '').trim();
  if (!parts(version)) throw new Error('A valid Notify target version is required.');
  const paths = notifyUpdatePaths(env);
  const lock = await acquireLock(paths);
  if (!lock.acquired) return { ok: true, skipped: true, reason: 'update_in_progress' };
  const previous = await readNotifyUpdateState(env);
  if (previous.activeVersion === version) {
    await lock.release();
    return { ok: true, skipped: true, reason: 'already_current', currentVersion: version };
  }
  const npm = String(options.npmPath || env.MAGCLAW_NOTIFY_NPM_PATH || 'npm');
  let packageInstalled = false;
  try {
    await appendLog(paths, 'client.update.started', { targetVersion: version });
    const install = run(npm, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${NOTIFY_PACKAGE_NAME}@${version}`], env);
    if (install.status !== 0) throw new Error(String(install.stderr || install.stdout || `npm exited ${install.status}`).trim());
    packageInstalled = true;
    const verify = run(npm, ['exec', '--yes', `--package=${NOTIFY_PACKAGE_NAME}@${version}`, '--', 'magclaw-notify', '--version'], env);
    if (verify.status !== 0 || String(verify.stdout || '').trim() !== version) throw new Error(`Installed Notify ${version} failed verification.`);
    const integrationsFile = path.join(path.dirname(path.dirname(paths.root)), 'integrations.json');
    const integrations = await readFile(integrationsFile, 'utf8').then(JSON.parse).catch(() => ({}));
    const targets = Array.isArray(integrations.targets) ? integrations.targets.map(String).filter(Boolean) : [];
    if (targets.length) {
      const sync = run(npm, ['exec', '--yes', `--package=${NOTIFY_PACKAGE_NAME}@${version}`, '--', 'magclaw-notify', 'install', '--targets', [...new Set(targets)].join(',')], env);
      if (sync.status !== 0) throw new Error(String(sync.stderr || sync.stdout || 'Notify integration refresh failed.').trim());
    }
    const state = { version: 1, activeVersion: version, previousVersion: previous.activeVersion || options.currentVersion || '', lastCheckAt: new Date().toISOString(), lastUpdate: { ok: true, version, at: new Date().toISOString() } };
    await writeAtomic(paths.state, state);
    await appendLog(paths, 'client.update.succeeded', { targetVersion: version });
    return { ok: true, updated: true, currentVersion: version, previousVersion: state.previousVersion };
  } catch (error) {
    let rolledBack = false;
    if (packageInstalled && parts(previous.activeVersion || options.currentVersion || '')) {
      const rollbackVersion = previous.activeVersion || options.currentVersion;
      const rollback = run(npm, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${NOTIFY_PACKAGE_NAME}@${rollbackVersion}`], env);
      rolledBack = rollback.status === 0;
    }
    await writeAtomic(paths.state, { ...previous, lastUpdate: { ok: false, targetVersion: version, error: String(error.message).slice(0, 500), rolledBack, at: new Date().toISOString() } });
    await appendLog(paths, 'client.update.failed', { targetVersion: version, error: String(error.message).slice(0, 300) });
    throw error;
  } finally { await lock.release(); }
}

export async function rollbackNotifyUpdate(options = {}, env = process.env) {
  const state = await readNotifyUpdateState(env);
  if (!parts(state.previousVersion || '')) throw new Error('No verified previous Notify version is available for rollback.');
  return applyNotifyUpdate(state.previousVersion, { ...options, currentVersion: state.activeVersion }, env);
}

export async function runNotifyBackgroundUpdate(currentVersion, options = {}, env = process.env) {
  const paths = notifyUpdatePaths(env);
  const state = await readNotifyUpdateState(env);
  const last = Date.parse(state.lastCheckAt || '');
  if (!options.force && Number.isFinite(last) && Date.now() - last < NOTIFY_UPDATE_TTL_MS) return { ok: true, skipped: true, reason: 'fresh' };
  let check;
  try { check = await checkNotifyUpdate({ ...options, currentVersion }, env); }
  catch (error) {
    await writeAtomic(paths.state, { ...state, lastCheckAt: new Date().toISOString(), lastCheck: { ok: false, error: String(error.message).slice(0, 500) } });
    await appendLog(paths, 'client.update.check_failed', { error: String(error.message).slice(0, 300) });
    return { ok: false, error: error.message };
  }
  await writeAtomic(paths.state, { ...state, lastCheckAt: check.checkedAt, lastCheck: check });
  if (!check.updateAvailable) return { ...check, updated: false };
  return applyNotifyUpdate(check.latestVersion, { ...options, currentVersion }, env);
}

export function scheduleNotifyBackgroundUpdate(currentVersion, options = {}, env = process.env) {
  if (env.MAGCLAW_NOTIFY_AUTO_UPDATE === '0' || options.disabled) return { scheduled: false, reason: 'auto_update_disabled' };
  const paths = notifyUpdatePaths(env);
  try {
    const state = JSON.parse(requireRead(paths.state));
    const last = Date.parse(state.lastCheckAt || '');
    if (Number.isFinite(last) && Date.now() - last < NOTIFY_UPDATE_TTL_MS) return { scheduled: false, reason: 'fresh' };
  } catch {}
  const entry = fileURLToPath(new URL('../bin/magclaw-notify.js', import.meta.url));
  const child = spawn(process.execPath, [entry, 'update', 'background-check', '--current-version', String(currentVersion)], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env, MAGCLAW_NOTIFY_UPDATE_CHILD: '1' },
  });
  child.unref();
  return { scheduled: true, pid: child.pid };
}

function requireRead(file) {
  try { return process.getBuiltinModule('fs').readFileSync(file, 'utf8'); } catch { return '{}'; }
}
