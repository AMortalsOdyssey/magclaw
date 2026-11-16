import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MIN_FILE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const FILE_TIMEOUT_MS = 250;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function* bodyRecords(payload) {
  for (const blob of asArray(payload?.shareContents)) {
    if (blob) yield [blob, blob.contentType];
  }
  for (const share of asArray(payload?.shares)) {
    if (!share) continue;
    yield [share, share.contentType];
    for (const version of asArray(share.versions)) {
      if (version) yield [version, version.contentType || share.contentType];
    }
  }
}

function useReference(record, reference) {
  delete record.content;
  record.bodyFile = reference;
}

export function applyCommittedShareBodies(payload, changes) {
  if (!changes?.length) return;
  const byId = new Map(changes.map((change) => [change.id, change]));
  for (const [record] of bodyRecords(payload)) {
    const change = byId.get(record.id);
    if (change?.reference && record.content === change.content) useReference(record, change.reference);
  }
}

export function adoptShareBodyReferences(payload, storedPayload) {
  const references = new Map();
  for (const [record] of bodyRecords(storedPayload)) {
    if (record.id && record.bodyFile) references.set(record.id, record.bodyFile);
  }
  for (const [record] of bodyRecords(payload)) {
    const reference = references.get(record.id);
    if (reference && typeof record.content === 'string'
      && (!record.workspaceId || record.workspaceId === reference.workspaceId)
      && Buffer.byteLength(record.content) === reference.bytes && sha256(record.content) === reference.sha256) {
      useReference(record, reference);
    }
  }
}

export function createTeamShareBodyStore({ uploadDir, table, withClient, previewText }) {
  const root = uploadDir ? path.join(uploadDir, '.team-sharing-bodies') : '';
  const bodiesTable = table('cloud_team_share_bodies');
  const settingsTable = table('cloud_team_share_body_settings');
  let fileOperations = 0;
  let lastFileWarning = 0;

  function checkedReference(ref) {
    if (!ref || typeof ref.workspaceId !== 'string' || !ref.workspaceId
      || !/^[a-f0-9]{64}$/.test(ref.sha256)
      || !Number.isInteger(ref.bytes) || ref.bytes < MIN_FILE_BYTES || ref.bytes > MAX_FILE_BYTES) {
      throw new Error('Invalid Team Sharing body reference.');
    }
    return ref;
  }

  function bodyPath(ref) {
    return path.join(root, sha256(ref.workspaceId), ref.sha256.slice(0, 2), `${ref.sha256}.html.gz`);
  }

  function warnFileFallback(error) {
    if (Date.now() - lastFileWarning < 60_000) return;
    lastFileWarning = Date.now();
    console.warn(`[team-sharing-bodies] using PostgreSQL fallback code=${error.code || 'invalid_file'}`);
  }

  async function tryFileOperation(fn) {
    // Keep a slot occupied until the filesystem call finishes, even after the
    // response falls back. A stalled NFS mount cannot consume the whole pool.
    if (!root || fileOperations >= 2) return null;
    fileOperations += 1;
    let timer;
    const operation = Promise.resolve().then(fn).catch((error) => {
      warnFileFallback(error);
      return null;
    }).finally(() => {
      clearTimeout(timer);
      fileOperations -= 1;
    });
    return Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          warnFileFallback({ code: 'timeout' });
          resolve(null);
        }, FILE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  }

  async function writeFileCopy(ref, content) {
    return tryFileOperation(async () => {
      const target = bodyPath(ref);
      const dir = path.dirname(target);
      const temporary = path.join(dir, `.${ref.sha256}.${randomUUID()}.tmp`);
      const encoded = await compress(content);
      await mkdir(dir, { recursive: true, mode: 0o750 });
      try {
        await writeFile(temporary, encoded, { flag: 'wx', flush: true, mode: 0o640 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return true;
    });
  }

  async function readFileCopy(ref) {
    return tryFileOperation(async () => {
      const file = await open(bodyPath(ref), 'r');
      let encoded;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > ref.bytes + 64 * 1024) throw new Error('Invalid body file.');
        encoded = await file.readFile();
      } finally {
        await file.close();
      }
      const decoded = await decompress(encoded, { maxOutputLength: ref.bytes });
      if (decoded.length !== ref.bytes || sha256(decoded) !== ref.sha256) throw new Error('Invalid body checksum.');
      return decoded.toString('utf8');
    });
  }

  async function readDatabaseCopy(client, ref) {
    const { rows } = await client.query(
      `SELECT body FROM ${bodiesTable} WHERE workspace_id = $1 AND content_hash = $2`,
      [ref.workspaceId, ref.sha256],
    );
    const body = rows[0]?.body;
    if (typeof body !== 'string' || Buffer.byteLength(body) !== ref.bytes || sha256(body) !== ref.sha256) {
      throw new Error('Team Sharing body is unavailable.');
    }
    return body;
  }

  async function read(reference) {
    const ref = checkedReference(reference);
    const fromFile = await readFileCopy(ref);
    if (fromFile !== null) return fromFile;
    const body = await withClient((client) => readDatabaseCopy(client, ref));
    // Reads can repair a missing or damaged file without delaying the response.
    void writeFileCopy(ref, body);
    return body;
  }

  async function storageEnabled(client) {
    // The shared lock also serializes enabling or rolling back storage with
    // transactions that are publishing share metadata.
    const { rows } = await client.query(`SELECT enabled FROM ${settingsTable} WHERE singleton FOR SHARE`);
    return rows[0]?.enabled === true && Boolean(root);
  }

  async function setEnabled(client, enabled) {
    if (enabled && !root) throw new Error('MAGCLAW_UPLOAD_DIR is required for Team Sharing body storage.');
    await client.query(`UPDATE ${settingsTable} SET enabled = $1 WHERE singleton`, [enabled]);
  }

  async function prepare(client, workspaceId, payload, enabled) {
    const changes = [];
    if (enabled) {
      const references = new Map();
      for (const [record, contentType] of bodyRecords(payload)) {
        const content = record.content;
        if (contentType !== 'html' || typeof content !== 'string' || content.length < MIN_FILE_BYTES / 3
          || (record.workspaceId && record.workspaceId !== workspaceId)) continue;
        const bytes = Buffer.byteLength(content);
        if (bytes < MIN_FILE_BYTES || bytes > MAX_FILE_BYTES) continue;
        let reference = references.get(content);
        if (!reference) {
          const hash = sha256(content);
          const result = await client.query(`
            INSERT INTO ${bodiesTable} (workspace_id, content_hash, body)
            VALUES ($1, $2, $3) ON CONFLICT (workspace_id, content_hash) DO NOTHING
          `, [workspaceId, hash, content]);
          reference = { workspaceId, sha256: hash, bytes, preview: previewText(content, 'html', 120) };
          references.set(content, reference);
          if (result.rowCount) await writeFileCopy(reference, content);
        }
        useReference(record, reference);
        changes.push({ id: record.id, content, reference });
      }
    } else {
      for (const [record] of bodyRecords(payload)) {
        if (!record.bodyFile) continue;
        record.content = await readDatabaseCopy(client, checkedReference(record.bodyFile));
        delete record.bodyFile;
        changes.push({ id: record.id });
      }
    }
    return changes;
  }

  return { prepare, read, setEnabled, storageEnabled };
}
