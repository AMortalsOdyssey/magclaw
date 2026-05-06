import { Pool } from 'pg';
import {
  DEFAULT_DATABASE,
  DEFAULT_MAINTENANCE_DATABASE,
  DEFAULT_SCHEMA,
  databaseNameFromUrl,
  databaseUrlWithName,
  migratePostgres,
  normalizeDatabaseUrl,
  quoteIdent,
  redactDatabaseUrl,
} from './postgres.js';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value) {
  return iso(value) || new Date().toISOString();
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstRow(result) {
  return result.rows[0] || null;
}

function tableName(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function userFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    passwordHash: row.password_hash || '',
    avatarUrl: row.avatar_url || '',
    emailVerifiedAt: iso(row.email_verified_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastLoginAt: iso(row.last_login_at),
    disabledAt: iso(row.disabled_at),
    metadata: jsonObject(row.metadata),
  };
}

function workspaceFromRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    metadata: jsonObject(row.metadata),
  };
}

function memberFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    humanId: row.human_id || '',
    role: row.role,
    status: row.status,
    joinedAt: iso(row.joined_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    removedAt: iso(row.removed_at),
    metadata: jsonObject(row.metadata),
  };
}

function sessionFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: requiredIso(row.created_at),
    expiresAt: requiredIso(row.expires_at),
    userAgent: row.user_agent || '',
    ipHash: row.ip_hash || '',
    revokedAt: iso(row.revoked_at),
    lastSeenAt: iso(row.last_seen_at),
    metadata: jsonObject(row.metadata),
  };
}

function invitationFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    invitedBy: row.invited_by || null,
    expiresAt: requiredIso(row.expires_at),
    acceptedAt: iso(row.accepted_at),
    revokedAt: iso(row.revoked_at),
    createdAt: requiredIso(row.created_at),
    metadata: jsonObject(row.metadata),
  };
}

export function cloudPostgresOptionsFromEnv(env = process.env) {
  const databaseUrl = normalizeDatabaseUrl(env.MAGCLAW_DATABASE_URL || env.DATABASE_URL || '');
  if (!databaseUrl) return null;
  return {
    databaseUrl,
    database: env.MAGCLAW_DATABASE || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE),
    schema: env.MAGCLAW_DATABASE_SCHEMA || DEFAULT_SCHEMA,
    maintenanceDatabase: env.MAGCLAW_MAINTENANCE_DATABASE || DEFAULT_MAINTENANCE_DATABASE,
    createDatabase: env.MAGCLAW_DATABASE_CREATE !== '0',
  };
}

export function createCloudPostgresStore(optionsInput = {}) {
  const options = {
    ...(cloudPostgresOptionsFromEnv() || {}),
    ...optionsInput,
  };
  const databaseUrl = normalizeDatabaseUrl(options.databaseUrl || '');
  if (!databaseUrl) return null;

  const database = options.database || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE);
  const schema = options.schema || DEFAULT_SCHEMA;
  const maintenanceDatabase = options.maintenanceDatabase || DEFAULT_MAINTENANCE_DATABASE;
  const createDatabase = options.createDatabase !== false;
  let pool = options.pool || null;
  let initialized = false;
  let migration = null;

  function table(name) {
    return tableName(schema, name);
  }

  async function withClient(fn) {
    if (!pool) {
      pool = new Pool({ connectionString: databaseUrlWithName(databaseUrl, database) });
    }
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function isEmpty(client) {
    const result = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ${table('cloud_users')}) AS users,
        (SELECT COUNT(*)::int FROM ${table('cloud_workspaces')}) AS workspaces
    `);
    const row = firstRow(result);
    return Number(row?.users || 0) === 0 && Number(row?.workspaces || 0) === 0;
  }

  async function persistFromState(state) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (const workspace of safeArray(cloud.workspaces)) {
          await client.query(`
            INSERT INTO ${table('cloud_workspaces')}
              (id, slug, name, created_at, updated_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
          `, [
            workspace.id,
            workspace.slug || workspace.id,
            workspace.name || workspace.slug || workspace.id,
            requiredIso(workspace.createdAt),
            requiredIso(workspace.updatedAt || workspace.createdAt),
            JSON.stringify(jsonObject(workspace.metadata)),
          ]);
        }

        for (const user of safeArray(cloud.users)) {
          await client.query(`
            INSERT INTO ${table('cloud_users')}
              (id, email, normalized_email, name, password_hash, avatar_url,
               email_verified_at, created_at, updated_at, last_login_at, disabled_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              email = EXCLUDED.email,
              normalized_email = EXCLUDED.normalized_email,
              name = EXCLUDED.name,
              password_hash = EXCLUDED.password_hash,
              avatar_url = EXCLUDED.avatar_url,
              email_verified_at = EXCLUDED.email_verified_at,
              updated_at = EXCLUDED.updated_at,
              last_login_at = EXCLUDED.last_login_at,
              disabled_at = EXCLUDED.disabled_at,
              metadata = EXCLUDED.metadata
          `, [
            user.id,
            user.email,
            normalizeEmail(user.email),
            user.name || '',
            user.passwordHash || null,
            user.avatarUrl || '',
            iso(user.emailVerifiedAt),
            requiredIso(user.createdAt),
            requiredIso(user.updatedAt || user.createdAt),
            iso(user.lastLoginAt),
            iso(user.disabledAt),
            JSON.stringify(jsonObject(user.metadata)),
          ]);
        }

        for (const member of safeArray(cloud.workspaceMembers)) {
          await client.query(`
            INSERT INTO ${table('cloud_workspace_members')}
              (id, workspace_id, user_id, human_id, role, status, joined_at,
               created_at, updated_at, removed_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              user_id = EXCLUDED.user_id,
              human_id = EXCLUDED.human_id,
              role = EXCLUDED.role,
              status = EXCLUDED.status,
              joined_at = EXCLUDED.joined_at,
              updated_at = EXCLUDED.updated_at,
              removed_at = EXCLUDED.removed_at,
              metadata = EXCLUDED.metadata
          `, [
            member.id,
            member.workspaceId,
            member.userId,
            member.humanId || null,
            member.role || 'member',
            member.status || 'active',
            iso(member.joinedAt),
            requiredIso(member.createdAt),
            requiredIso(member.updatedAt || member.createdAt),
            iso(member.removedAt),
            JSON.stringify(jsonObject(member.metadata)),
          ]);
        }

        for (const session of safeArray(cloud.sessions)) {
          await client.query(`
            INSERT INTO ${table('cloud_sessions')}
              (id, user_id, token_hash, created_at, expires_at, user_agent,
               ip_hash, revoked_at, last_seen_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              token_hash = EXCLUDED.token_hash,
              expires_at = EXCLUDED.expires_at,
              user_agent = EXCLUDED.user_agent,
              ip_hash = EXCLUDED.ip_hash,
              revoked_at = EXCLUDED.revoked_at,
              last_seen_at = EXCLUDED.last_seen_at,
              metadata = EXCLUDED.metadata
          `, [
            session.id,
            session.userId,
            session.tokenHash,
            requiredIso(session.createdAt),
            requiredIso(session.expiresAt),
            session.userAgent || '',
            session.ipHash || '',
            iso(session.revokedAt),
            iso(session.lastSeenAt),
            JSON.stringify(jsonObject(session.metadata)),
          ]);
        }

        for (const invitation of safeArray(cloud.invitations)) {
          await client.query(`
            INSERT INTO ${table('cloud_invitations')}
              (id, workspace_id, email, normalized_email, role, token_hash,
               invited_by, expires_at, accepted_at, revoked_at, created_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              email = EXCLUDED.email,
              normalized_email = EXCLUDED.normalized_email,
              role = EXCLUDED.role,
              token_hash = EXCLUDED.token_hash,
              invited_by = EXCLUDED.invited_by,
              expires_at = EXCLUDED.expires_at,
              accepted_at = EXCLUDED.accepted_at,
              revoked_at = EXCLUDED.revoked_at,
              metadata = EXCLUDED.metadata
          `, [
            invitation.id,
            invitation.workspaceId,
            invitation.email,
            normalizeEmail(invitation.email),
            invitation.role || 'member',
            invitation.tokenHash,
            invitation.invitedBy || null,
            requiredIso(invitation.expiresAt),
            iso(invitation.acceptedAt),
            iso(invitation.revokedAt),
            requiredIso(invitation.createdAt),
            JSON.stringify(jsonObject(invitation.metadata)),
          ]);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function loadIntoState(state) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      const workspaces = await client.query(`SELECT * FROM ${table('cloud_workspaces')} ORDER BY created_at ASC, id ASC`);
      const users = await client.query(`SELECT * FROM ${table('cloud_users')} ORDER BY created_at ASC, id ASC`);
      const members = await client.query(`SELECT * FROM ${table('cloud_workspace_members')} ORDER BY created_at ASC, id ASC`);
      const sessions = await client.query(`SELECT * FROM ${table('cloud_sessions')} ORDER BY created_at ASC, id ASC`);
      const invitations = await client.query(`SELECT * FROM ${table('cloud_invitations')} ORDER BY created_at ASC, id ASC`);
      cloud.workspaces = workspaces.rows.map(workspaceFromRow);
      cloud.users = users.rows.map(userFromRow);
      cloud.workspaceMembers = members.rows.map(memberFromRow);
      cloud.sessions = sessions.rows.map(sessionFromRow);
      cloud.invitations = invitations.rows.map(invitationFromRow);
      state.cloud = cloud;
    });
  }

  async function initialize(state) {
    if (initialized) return { ok: true, enabled: true, migration, database, schema };
    migration = await migratePostgres({
      databaseUrl,
      database,
      schema,
      maintenanceDatabase,
      createDatabase,
    });
    await withClient(async (client) => {
      if (await isEmpty(client)) await persistFromState(state);
    });
    await loadIntoState(state);
    initialized = true;
    console.info(`[cloud-postgres] connected database=${database} schema=${schema}`);
    return { ok: true, enabled: true, migration, database, schema };
  }

  async function close() {
    if (pool && !options.pool) await pool.end();
    pool = null;
    initialized = false;
  }

  return {
    close,
    initialize,
    isEnabled: () => true,
    loadIntoState,
    persistFromState,
    publicInfo: () => ({
      backend: 'postgres',
      database,
      schema,
      url: redactDatabaseUrl(databaseUrl),
    }),
  };
}
