import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const STATE_FILES = new Map([
  ['config.json', 'config'],
  ['directory.json', 'directory'],
  ['memory.json', 'memory'],
  ['target-grants.json', 'grants'],
  ['pending-confirmations.json', 'pending'],
  ['receipts.json', 'receipts'],
]);
const stores = new Map();
const storePromises = new Map();

function now() {
  return new Date().toISOString();
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function locationFor(file) {
  if (typeof file !== 'string' || !file) return null;
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const base = path.basename(absolute);
  if (path.basename(parent) === 'notify' && STATE_FILES.has(base)) {
    return { root: parent, collection: STATE_FILES.get(base), key: 'state' };
  }
  if (path.basename(parent) === 'requests' && path.basename(path.dirname(parent)) === 'notify' && base.endsWith('.json')) {
    return { root: path.dirname(parent), collection: 'requests', key: base.slice(0, -5) };
  }
  return null;
}

class NotifyStateStore {
  constructor(root, database) {
    this.root = root;
    this.databasePath = path.join(root, 'state.db');
    this.database = database;
    this.readValueStatement = database.prepare('SELECT value FROM notify_kv WHERE collection = ? AND item_key = ?');
    this.writeValueStatement = database.prepare(`
      INSERT INTO notify_kv (collection, item_key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(collection, item_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.readConfirmationsStatement = database.prepare('SELECT value FROM notify_confirmations ORDER BY created_at ASC, id ASC');
    this.writeConfirmationStatement = database.prepare(`
      INSERT INTO notify_confirmations (id, status, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.compareAndSwapConfirmationStatement = database.prepare(`
      UPDATE notify_confirmations
      SET status = ?, value = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `);
    this.readIntentByRequestStatement = database.prepare('SELECT * FROM delivery_intents WHERE request_id = ?');
    this.readIntentStatement = database.prepare('SELECT * FROM delivery_intents WHERE id = ?');
    this.listRecoverableStatement = database.prepare("SELECT * FROM delivery_intents WHERE status IN ('pending', 'sending', 'sent_unconfirmed') ORDER BY created_at ASC");
    this.createIntentStatement = database.prepare(`
      INSERT INTO delivery_intents (id, request_id, status, request_json, idempotency_key, result_json, error, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, NULL, '', ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `);
    this.updateIntentStatement = database.prepare(`
      UPDATE delivery_intents
      SET status = ?, result_json = ?, error = ?, updated_at = ?
      WHERE id = ?
    `);
  }

  read(collection, key, fallback) {
    if (collection === 'pending' && key === 'state') {
      const rows = this.readConfirmationsStatement.all();
      return rows.length ? rows.map((row) => parse(row.value, null)).filter(Boolean) : fallback;
    }
    const row = this.readValueStatement.get(collection, key);
    return row ? parse(row.value, fallback) : fallback;
  }

  write(collection, key, value) {
    if (collection === 'pending' && key === 'state') {
      for (const confirmation of Array.isArray(value) ? value : []) this.writeConfirmation(confirmation);
      return;
    }
    this.writeValueStatement.run(collection, key, JSON.stringify(value), now());
  }

  writeConfirmation(confirmation) {
    if (!confirmation?.id) throw new Error('Notify confirmation id is required.');
    const timestamp = now();
    this.writeConfirmationStatement.run(
      String(confirmation.id),
      String(confirmation.status || 'pending'),
      JSON.stringify(confirmation),
      String(confirmation.createdAt || timestamp),
      String(confirmation.updatedAt || timestamp),
    );
    return confirmation;
  }

  compareAndSwapConfirmation(id, expectedStatus, confirmation) {
    if (!id || confirmation?.id !== id) throw new Error('Notify confirmation CAS requires a matching id.');
    const result = this.compareAndSwapConfirmationStatement.run(
      String(confirmation.status || ''),
      JSON.stringify(confirmation),
      String(confirmation.updatedAt || now()),
      String(id),
      String(expectedStatus),
    );
    return Number(result.changes || 0) === 1;
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new Error('Notify state transaction callback is required.');
    if (this.transactionDepth > 0) return fn(this);
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn(this);
      if (result && typeof result.then === 'function') {
        throw new Error('Notify state transaction callbacks must be synchronous.');
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  createDeliveryIntent({ id, requestId, request, idempotencyKey }) {
    const timestamp = now();
    this.createIntentStatement.run(id, requestId, JSON.stringify(request), idempotencyKey, timestamp, timestamp);
    return this.deliveryIntentForRequest(requestId);
  }

  deliveryIntentForRequest(requestId) {
    return this.normalizeIntent(this.readIntentByRequestStatement.get(requestId));
  }

  deliveryIntent(id) {
    return this.normalizeIntent(this.readIntentStatement.get(id));
  }

  updateDeliveryIntent(id, status, options = {}) {
    const current = this.deliveryIntent(id);
    if (!current) throw new Error(`Notify delivery intent not found: ${id}`);
    const result = Object.hasOwn(options, 'result') ? options.result : current.result;
    const error = Object.hasOwn(options, 'error') ? String(options.error || '') : current.error;
    this.updateIntentStatement.run(status, result == null ? null : JSON.stringify(result), error, now(), id);
    return this.deliveryIntent(id);
  }

  listRecoverableDeliveryIntents() {
    return this.listRecoverableStatement.all().map((row) => this.normalizeIntent(row));
  }

  normalizeIntent(row) {
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.request_id,
      status: row.status,
      request: parse(row.request_json, null),
      idempotencyKey: row.idempotency_key,
      result: row.result_json ? parse(row.result_json, null) : null,
      error: row.error || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  close() {
    this.database.close();
    stores.delete(this.root);
  }
}

async function rawJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function migrateLegacyFiles(store) {
  const migrated = store.database.prepare("SELECT value FROM notify_meta WHERE key = 'legacy_json_migrated'").get();
  if (migrated) return;
  const archives = [];
  const entries = [];
  for (const [filename, collection] of STATE_FILES) {
    const file = path.join(store.root, filename);
    const missing = Symbol('missing');
    const value = await rawJson(file, missing);
    if (value === missing) continue;
    entries.push({ collection, key: 'state', value });
    archives.push(file);
  }
  const requestDir = path.join(store.root, 'requests');
  for (const entry of await readdir(requestDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(requestDir, entry.name);
    const value = await rawJson(file, null);
    if (!value) continue;
    entries.push({ collection: 'requests', key: entry.name.slice(0, -5), value });
    archives.push(file);
  }
  store.database.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries) store.write(entry.collection, entry.key, entry.value);
    store.database.prepare("INSERT INTO notify_meta (key, value) VALUES ('legacy_json_migrated', ?)").run(now());
    store.database.exec('COMMIT');
  } catch (error) {
    store.database.exec('ROLLBACK');
    throw error;
  }
  const suffix = `.migrated-${Date.now()}`;
  for (const file of archives) await rename(file, `${file}${suffix}`).catch(() => {});
}

function migratePendingConfirmations(store) {
  const migrated = store.database.prepare("SELECT value FROM notify_meta WHERE key = 'pending_confirmations_migrated'").get();
  if (migrated) return;
  store.transaction(() => {
    const legacy = store.database.prepare("SELECT value FROM notify_kv WHERE collection = 'pending' AND item_key = 'state'").get();
    for (const confirmation of parse(legacy?.value || '[]', [])) store.writeConfirmation(confirmation);
    store.database.prepare("INSERT OR REPLACE INTO notify_meta (key, value) VALUES ('pending_confirmations_migrated', ?)").run(now());
  });
}

export async function ensureNotifyStateStore(profilePaths) {
  const root = path.join(path.resolve(profilePaths.dir), 'notify');
  if (stores.has(root)) return stores.get(root);
  if (storePromises.has(root)) return storePromises.get(root);
  const pending = (async () => {
    await mkdir(path.join(root, 'requests'), { recursive: true, mode: 0o700 });
    const databasePath = path.join(root, 'state.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS notify_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_kv (
        collection TEXT NOT NULL,
        item_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, item_key)
      );
      CREATE TABLE IF NOT EXISTS delivery_intents (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent_unconfirmed', 'done', 'failed')),
        request_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        result_json TEXT,
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_confirmations (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notify_confirmations_status_idx ON notify_confirmations(status, updated_at);
      CREATE INDEX IF NOT EXISTS delivery_intents_status_idx ON delivery_intents(status, updated_at);
    `);
    await chmod(databasePath, 0o600).catch(() => {});
    const store = new NotifyStateStore(root, database);
    stores.set(root, store);
    try {
      await migrateLegacyFiles(store);
      migratePendingConfirmations(store);
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  })();
  storePromises.set(root, pending);
  try {
    return await pending;
  } finally {
    storePromises.delete(root);
  }
}

export function notifyStateStoreForFile(file) {
  const location = locationFor(file);
  if (!location) return null;
  const store = stores.get(location.root);
  return store ? { store, ...location } : null;
}

export function closeNotifyStateStore(profilePaths) {
  const root = path.join(path.resolve(profilePaths.dir), 'notify');
  stores.get(root)?.close();
}

export { locationFor as notifyStateLocationForFile };
