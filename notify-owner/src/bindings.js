import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeNotifyStateStore, ensureNotifyStateStore } from './store.js';

function clean(value = '', max = 120) {
  return String(value || '').normalize('NFKC').trim().replace(/\u0000/g, '').slice(0, max);
}

export function normalizeNotifyBotId(value = '') {
  const id = clean(value, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error('Notify Bot id must contain lowercase letters or numbers.');
  return id;
}

export function notifyBindingsPaths(env = process.env) {
  const home = path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
  return { home, file: path.join(home, 'bindings.json'), backup: path.join(home, 'bindings.json.bak'), lock: path.join(home, 'bindings.lock') };
}

async function withRegistryLock(paths, callback) {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      try { return await callback(); } finally { await rm(paths.lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const age = Date.now() - await stat(paths.lock).then((info) => info.mtimeMs).catch(() => Date.now());
      if (age > 30_000) { await rm(paths.lock, { recursive: true, force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 + attempt)));
    }
  }
  throw new Error('Notify Bot Binding registry is busy; retry the command.');
}

async function writeAtomic(file, value, backup = true) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (backup && await stat(file).then(() => true).catch(() => false)) await writeFile(`${file}.bak`, await readFile(file), { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeRegistry(value = {}) {
  return {
    version: 1,
    bindings: Array.isArray(value.bindings) ? value.bindings.filter(Boolean).map((binding) => ({
      id: normalizeNotifyBotId(binding.id),
      name: clean(binding.name || binding.id, 120),
      channel: binding.channel === 'feishu' ? 'feishu' : 'feishu',
      accountId: clean(binding.accountId, 120),
      enabled: binding.enabled !== false,
      legacy: binding.legacy === true,
      createdAt: binding.createdAt || null,
      updatedAt: binding.updatedAt || null,
    })) : [],
    updatedAt: value.updatedAt || null,
  };
}

export async function readNotifyBindings(env = process.env) {
  const paths = notifyBindingsPaths(env);
  try { return { paths, registry: normalizeRegistry(JSON.parse(await readFile(paths.file, 'utf8'))), recoveredFromBackup: false }; }
  catch (error) {
    if (error?.code === 'ENOENT') return { paths, registry: normalizeRegistry({}), recoveredFromBackup: false };
    try {
      const registry = normalizeRegistry(JSON.parse(await readFile(paths.backup, 'utf8')));
      await writeAtomic(paths.file, { ...registry, recoveredAt: new Date().toISOString() }, false);
      return { paths, registry, recoveredFromBackup: true };
    } catch { throw new Error(`Notify Bot Binding registry is invalid and no valid backup is available: ${paths.file}`); }
  }
}

export function notifyBindingProfile(binding, env = process.env) {
  const { home } = notifyBindingsPaths(env);
  const id = normalizeNotifyBotId(binding?.id || binding);
  const root = binding?.legacy === true ? path.join(home, 'daemon') : path.join(home, 'bindings', id);
  return {
    instance: id,
    bindingId: id,
    home,
    root,
    config: path.join(root, 'config.json'),
    pid: path.join(root, 'run', 'daemon.pid'),
    stdout: path.join(root, 'logs', 'daemon.log'),
    stderr: path.join(root, 'logs', 'daemon.error.log'),
    auditDir: path.join(root, 'audit'),
    handler: { dir: root, config: path.join(root, 'config.json'), profile: id, bindingId: id },
  };
}

export async function addNotifyBinding(options = {}, env = process.env) {
  const accountId = clean(options.accountId, 120);
  const name = clean(options.name || accountId, 120);
  if (!accountId) throw new Error('A Feishu account id is required for the Notify Bot Binding.');
  if (!name) throw new Error('A display name is required for the Notify Bot Binding.');
  const proposed = options.id || `${name}-${crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 6)}`;
  const id = normalizeNotifyBotId(proposed);
  const paths = notifyBindingsPaths(env);
  return withRegistryLock(paths, async () => {
    const { registry } = await readNotifyBindings(env);
    const conflict = registry.bindings.find((binding) => binding.id === id);
    if (conflict && conflict.accountId !== accountId) throw new Error(`Notify Bot id ${id} is already used by another Feishu account.`);
    const timestamp = new Date().toISOString();
    const binding = {
      id, name, channel: 'feishu', accountId,
      enabled: options.enabled !== false,
      legacy: options.legacy === true,
      createdAt: conflict?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    registry.bindings = [...registry.bindings.filter((item) => item.id !== id), binding];
    registry.updatedAt = timestamp;
    await writeAtomic(paths.file, registry);
    return { binding, profile: notifyBindingProfile(binding, env), recoveredFromBackup: false };
  });
}

export async function ensureLegacyNotifyBinding(options = {}, env = process.env) {
  const current = await readNotifyBindings(env);
  if (current.registry.bindings.length) return current;
  const legacyRootConfig = await readFile(path.join(current.paths.home, 'daemon', 'config.json'), 'utf8').then(JSON.parse).catch(() => null);
  const legacyHandlerConfig = await readFile(path.join(current.paths.home, 'daemon', 'notify', 'config.json'), 'utf8').then(JSON.parse).catch(() => null);
  let legacyStoredConfig = null;
  if (!legacyHandlerConfig && await stat(path.join(current.paths.home, 'daemon', 'notify', 'state.db')).then(() => true).catch(() => false)) {
    const profile = { dir: path.join(current.paths.home, 'daemon'), profile: 'default' };
    const store = await ensureNotifyStateStore(profile);
    try { legacyStoredConfig = store.read('config', 'state', null); } finally { closeNotifyStateStore(profile); }
  }
  const legacyConfig = legacyRootConfig || legacyHandlerConfig || legacyStoredConfig;
  if (!legacyConfig) return current;
  const accountId = clean(options.accountId || legacyHandlerConfig?.deliveryProvider?.account || legacyHandlerConfig?.confirmationProvider?.account || legacyStoredConfig?.deliveryProvider?.account || legacyStoredConfig?.confirmationProvider?.account || legacyConfig.deliveryProvider?.account || legacyConfig.confirmationProvider?.account || 'monkey', 120);
  await addNotifyBinding({ id: options.id || accountId || 'default', name: options.name || legacyConfig.relayName || accountId || 'Notify Bot', accountId, legacy: true }, env);
  return readNotifyBindings(env);
}

export async function resolveNotifyBinding(options = {}, env = process.env) {
  const { registry, recoveredFromBackup } = await ensureLegacyNotifyBinding(options, env);
  const enabled = registry.bindings.filter((binding) => binding.enabled !== false);
  const requested = options.bot ? normalizeNotifyBotId(options.bot) : '';
  if (requested) {
    const binding = registry.bindings.find((item) => item.id === requested);
    if (!binding) throw new Error(`Notify Bot ${requested} is not configured. Available: ${registry.bindings.map((item) => item.id).join(', ') || 'none'}.`);
    if (binding.enabled === false && options.includeDisabled !== true) throw new Error(`Notify Bot ${requested} is disabled.`);
    return { binding, profile: notifyBindingProfile(binding, env), recoveredFromBackup };
  }
  if (enabled.length === 1) return { binding: enabled[0], profile: notifyBindingProfile(enabled[0], env), recoveredFromBackup };
  if (!enabled.length) throw new Error('No Notify Bot Binding is configured. Run magclaw-notify-owner bot add --account-id ACCOUNT --name NAME.');
  throw new Error(`Multiple Notify Bots are configured. Use --bot ID. Available: ${enabled.map((item) => item.id).join(', ')}.`);
}

export async function listNotifyBindings(env = process.env) {
  const { registry, recoveredFromBackup } = await ensureLegacyNotifyBinding({}, env);
  return { recoveredFromBackup, bindings: registry.bindings.map((binding) => ({ ...binding, profileRoot: undefined })) };
}

export async function setNotifyBindingEnabled(id, enabled, env = process.env) {
  const selected = normalizeNotifyBotId(id);
  const paths = notifyBindingsPaths(env);
  return withRegistryLock(paths, async () => {
    const { registry } = await readNotifyBindings(env);
    const binding = registry.bindings.find((item) => item.id === selected);
    if (!binding) throw new Error(`Notify Bot ${selected} is not configured.`);
    binding.enabled = Boolean(enabled);
    binding.updatedAt = new Date().toISOString();
    registry.updatedAt = binding.updatedAt;
    await writeAtomic(paths.file, registry);
    return { binding };
  });
}
