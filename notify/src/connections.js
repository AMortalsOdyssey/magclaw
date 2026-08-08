import crypto from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function cleanName(value = '') {
  const result = String(value || '').normalize('NFKC').trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!result) throw new Error('Notify connection name must contain letters or numbers.');
  return result;
}

export function notifyHome(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

export function discoverNotifyProjectRoot(start = process.cwd()) {
  let current = path.resolve(start || process.cwd());
  try { current = realpathSync(current); } catch {}
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start || process.cwd());
    current = parent;
  }
}

export function notifyProjectKey(projectRoot = process.cwd()) {
  const normalized = discoverNotifyProjectRoot(projectRoot);
  return `prj_${crypto.createHash('sha256').update(normalized).digest('base64url').slice(0, 22)}`;
}

export function notifyProjectPaths(options = {}) {
  const projectRoot = discoverNotifyProjectRoot(options.projectDir || options.cwd || process.cwd());
  const projectKey = notifyProjectKey(projectRoot);
  const root = path.join(notifyHome(options.env), 'projects', projectKey);
  return {
    projectRoot,
    projectKey,
    root,
    connections: path.join(root, 'connections.json'),
    backup: path.join(root, 'connections.json.bak'),
    lock: path.join(root, 'connections.lock'),
    auditDir: path.join(root, 'audit'),
  };
}

async function withRegistryLock(paths, callback) {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
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
  throw new Error('Notify project connections are busy; retry the command.');
}

async function parseJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeAtomic(file, value, { backup = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600).catch(() => {});
    if (backup && await stat(file).then(() => true).catch(() => false)) {
      await writeFile(`${file}.bak`, await readFile(file), { mode: 0o600 });
      await chmod(`${file}.bak`, 0o600).catch(() => {});
    }
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeRegistry(value = {}, paths = {}) {
  const connections = value?.connections && typeof value.connections === 'object' && !Array.isArray(value.connections)
    ? Object.fromEntries(Object.entries(value.connections).map(([name, connection]) => [cleanName(name), { ...connection, name: cleanName(connection?.name || name) }]))
    : {};
  const defaultConnection = value.defaultConnection && connections[value.defaultConnection] ? value.defaultConnection : '';
  return {
    version: 1,
    projectKey: paths.projectKey || value.projectKey || '',
    projectName: path.basename(paths.projectRoot || value.projectName || 'project'),
    defaultConnection,
    connections,
    updatedAt: value.updatedAt || null,
  };
}

export async function readNotifyConnections(options = {}) {
  const paths = notifyProjectPaths(options);
  try {
    return { paths, registry: normalizeRegistry(await parseJson(paths.connections), paths), recoveredFromBackup: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { paths, registry: normalizeRegistry({}, paths), recoveredFromBackup: false };
    try {
      const restored = normalizeRegistry(await parseJson(paths.backup), paths);
      await writeAtomic(paths.connections, { ...restored, recoveredAt: new Date().toISOString() }, { backup: false });
      return { paths, registry: restored, recoveredFromBackup: true };
    } catch {
      throw new Error(`Notify project connection state is invalid and no valid backup is available: ${paths.connections}`);
    }
  }
}

export async function saveNotifyConnection(connection, options = {}) {
  const name = cleanName(options.connection || connection?.name || 'default');
  const paths = notifyProjectPaths(options);
  return withRegistryLock(paths, async () => {
    const { registry } = await readNotifyConnections(options);
    const timestamp = new Date().toISOString();
    registry.connections[name] = {
      ...connection,
      name,
      connectionId: String(connection?.connectionId || `ncn_${crypto.randomUUID()}`),
      createdAt: connection?.createdAt || registry.connections[name]?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    if (!registry.defaultConnection || options.makeDefault === true || Object.keys(registry.connections).length === 1) registry.defaultConnection = name;
    registry.updatedAt = timestamp;
    await writeAtomic(paths.connections, registry);
    return { paths, registry, connection: registry.connections[name] };
  });
}

export async function selectNotifyConnection(options = {}) {
  const { paths, registry, recoveredFromBackup } = await readNotifyConnections(options);
  const names = Object.keys(registry.connections).sort();
  const explicit = options.connection ? cleanName(options.connection) : '';
  if (explicit) {
    if (!registry.connections[explicit]) throw new Error(`Notify connection ${explicit} is not configured for this project. Available: ${names.join(', ') || 'none'}.`);
    return { paths, registry, name: explicit, connection: registry.connections[explicit], recoveredFromBackup };
  }
  if (names.length === 1) return { paths, registry, name: names[0], connection: registry.connections[names[0]], recoveredFromBackup };
  if (registry.defaultConnection && registry.connections[registry.defaultConnection]) {
    return { paths, registry, name: registry.defaultConnection, connection: registry.connections[registry.defaultConnection], recoveredFromBackup };
  }
  if (!names.length) throw new Error('This project has no Notify connection. Run magclaw-notify login --token SETUP_TOKEN --connection NAME.');
  throw new Error(`This project has multiple Notify connections and no default. Use --connection NAME or run magclaw-notify connections use NAME. Available: ${names.join(', ')}.`);
}

export async function listNotifyConnections(options = {}) {
  const { paths, registry, recoveredFromBackup } = await readNotifyConnections(options);
  return {
    projectKey: paths.projectKey,
    projectName: registry.projectName,
    defaultConnection: registry.defaultConnection || null,
    recoveredFromBackup,
    connections: Object.entries(registry.connections).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({
      name,
      connectionId: item.connectionId,
      relayHandle: item.relayHandle || '',
      user: item.user || null,
      expiresAt: item.tokenExpiresAt || null,
      default: name === registry.defaultConnection,
    })),
  };
}

export async function useNotifyConnection(name, options = {}) {
  const selected = cleanName(name);
  const paths = notifyProjectPaths(options);
  return withRegistryLock(paths, async () => {
    const { registry } = await readNotifyConnections(options);
    if (!registry.connections[selected]) throw new Error(`Notify connection ${selected} is not configured for this project.`);
    registry.defaultConnection = selected;
    registry.updatedAt = new Date().toISOString();
    await writeAtomic(paths.connections, registry);
    return { projectKey: paths.projectKey, defaultConnection: selected };
  });
}

export async function removeNotifyConnection(name, options = {}) {
  const selected = cleanName(name);
  const paths = notifyProjectPaths(options);
  return withRegistryLock(paths, async () => {
    const { registry } = await readNotifyConnections(options);
    if (!registry.connections[selected]) return { projectKey: paths.projectKey, removed: false, connection: selected };
    delete registry.connections[selected];
    if (registry.defaultConnection === selected) {
      const remaining = Object.keys(registry.connections);
      registry.defaultConnection = remaining.length === 1 ? remaining[0] : '';
    }
    registry.updatedAt = new Date().toISOString();
    await writeAtomic(paths.connections, registry);
    return { projectKey: paths.projectKey, removed: true, connection: selected, defaultConnection: registry.defaultConnection || null };
  });
}

export async function projectRootForDisplay(value = process.cwd()) {
  try { return await realpath(discoverNotifyProjectRoot(value)); } catch { return discoverNotifyProjectRoot(value); }
}
