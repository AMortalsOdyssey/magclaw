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
import { normalizeReleaseNotes, RELEASE_COMPONENTS } from '../release-notes.js';

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

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return iso(value)?.slice(0, 10) || '';
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function computerStatus(value) {
  const status = String(value || '').trim();
  return ['pairing', 'connected', 'offline', 'disabled'].includes(status) ? status : 'offline';
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
    avatar: row.avatar || '',
    onboardingAgentId: row.onboarding_agent_id || '',
    newAgentGreetingEnabled: row.new_agent_greeting_enabled !== false,
    ownerUserId: row.owner_user_id || null,
    deletedAt: iso(row.deleted_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    metadata: jsonObject(row.metadata),
  };
}

function joinLinkFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tokenHash: row.token_hash,
    maxUses: Number(row.max_uses || 0),
    usedCount: Number(row.used_count || 0),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by || null,
    createdBy: row.created_by || null,
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
      humanId: row.human_id || '',
      email: row.email,
      role: row.role,
      tokenHash: row.token_hash,
      invitedBy: row.invited_by || null,
      expiresAt: requiredIso(row.expires_at),
      acceptedAt: iso(row.accepted_at),
      acceptedBy: row.accepted_by || null,
      revokedAt: iso(row.revoked_at),
      createdAt: requiredIso(row.created_at),
      metadata: jsonObject(row.metadata),
  };
}

function passwordResetFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdBy: row.created_by || null,
    expiresAt: requiredIso(row.expires_at),
    consumedAt: iso(row.consumed_at),
    revokedAt: iso(row.revoked_at),
    createdAt: requiredIso(row.created_at),
    metadata: jsonObject(row.metadata),
  };
}

function computerFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name || '',
    hostname: row.hostname || '',
    os: row.os || '',
    arch: row.arch || '',
    daemonVersion: row.daemon_version || '',
    status: row.status || 'offline',
    connectedVia: row.connected_via || 'daemon',
    runtimeIds: safeArray(row.runtime_ids),
    runtimeDetails: safeArray(row.runtime_details),
    capabilities: safeArray(row.capabilities),
    runningAgents: safeArray(row.running_agents),
    machineFingerprint: row.machine_fingerprint || '',
    createdBy: row.created_by || null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
    daemonConnectedAt: iso(row.daemon_connected_at),
    disconnectedAt: iso(row.disconnected_at),
    disabledAt: iso(row.disabled_at),
    metadata: jsonObject(row.metadata),
  };
}

function computerTokenFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    computerId: row.computer_id,
    label: row.label || '',
    tokenHash: row.token_hash,
    createdAt: requiredIso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    metadata: jsonObject(row.metadata),
  };
}

function pairingTokenFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    computerId: row.computer_id,
    label: row.label || '',
    tokenHash: row.token_hash,
    createdBy: row.created_by || null,
    createdAt: requiredIso(row.created_at),
    expiresAt: requiredIso(row.expires_at),
    consumedAt: iso(row.consumed_at),
    revokedAt: iso(row.revoked_at),
    metadata: jsonObject(row.metadata),
  };
}

function agentDeliveryFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    computerId: row.computer_id,
    messageId: row.message_id || null,
    workItemId: row.work_item_id || null,
    seq: Number(row.seq || 0),
    type: row.type,
    commandType: row.command_type,
    status: row.status,
    attempts: Number(row.attempts || 0),
    payload: jsonObject(row.payload),
    error: row.error || '',
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    sentAt: iso(row.sent_at),
    ackedAt: iso(row.acked_at),
  };
}

function daemonEventFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id || null,
    computerId: row.computer_id || null,
    type: row.type,
    message: row.message || '',
    meta: jsonObject(row.meta),
    createdAt: requiredIso(row.created_at),
  };
}

function releaseNoteRowId(component, version, category, position) {
  return [component, version, category, position]
    .map((part) => String(part || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
    .join('_')
    .slice(0, 180);
}

function releaseEntriesFromNotes(releaseNotesInput) {
  const releaseNotes = normalizeReleaseNotes(releaseNotesInput);
  const entries = [];
  for (const component of RELEASE_COMPONENTS) {
    for (const release of safeArray(releaseNotes[component]?.releases)) {
      for (const category of ['features', 'fixes', 'improved']) {
        safeArray(release[category]).forEach((body, position) => {
          entries.push({
            id: releaseNoteRowId(component, release.version, category, position),
            component,
            version: release.version,
            releasedAt: release.date,
            title: release.title || '',
            category,
            body: String(body || ''),
            position,
          });
        });
      }
    }
  }
  return entries.filter((entry) => entry.version && entry.releasedAt && entry.body);
}

function releaseNotesFromRows(rows, fallback) {
  const notes = normalizeReleaseNotes(fallback);
  const grouped = {
    web: new Map(),
    daemon: new Map(),
  };
  for (const row of safeArray(rows)) {
    const component = RELEASE_COMPONENTS.includes(row.component) ? row.component : '';
    if (!component) continue;
    const version = String(row.version || '').trim();
    const date = dateOnly(row.released_at);
    if (!version || !date) continue;
    const key = `${version}:${date}`;
    if (!grouped[component].has(key)) {
      grouped[component].set(key, {
        id: `${component}-${version}`,
        version,
        date,
        title: row.title || '',
        features: [],
        fixes: [],
        improved: [],
      });
    }
    const release = grouped[component].get(key);
    const category = ['features', 'fixes', 'improved'].includes(row.category) ? row.category : 'features';
    release[category].push(String(row.body || ''));
  }
  for (const component of RELEASE_COMPONENTS) {
    const releases = [...grouped[component].values()];
    if (releases.length) notes[component].releases = releases;
  }
  return normalizeReleaseNotes(notes);
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

  async function persistReleaseNotesFromState(client, state) {
    const entries = releaseEntriesFromNotes(state.releaseNotes);
    for (const entry of entries) {
      await client.query(`
        INSERT INTO ${table('cloud_release_notes')}
          (id, component, version, released_at, title, category, body, position, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          released_at = EXCLUDED.released_at,
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          body = EXCLUDED.body,
          position = EXCLUDED.position
      `, [
        entry.id,
        entry.component,
        entry.version,
        entry.releasedAt,
        entry.title,
        entry.category,
        entry.body,
        entry.position,
      ]);
    }
  }

  async function persistFromState(state) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await persistReleaseNotesFromState(client, state);

        for (const workspace of safeArray(cloud.workspaces)) {
          await client.query(`
            INSERT INTO ${table('cloud_workspaces')}
              (id, slug, name, avatar, onboarding_agent_id, new_agent_greeting_enabled,
               owner_user_id, deleted_at, created_at, updated_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              avatar = EXCLUDED.avatar,
              onboarding_agent_id = EXCLUDED.onboarding_agent_id,
              new_agent_greeting_enabled = EXCLUDED.new_agent_greeting_enabled,
              owner_user_id = EXCLUDED.owner_user_id,
              deleted_at = EXCLUDED.deleted_at,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
          `, [
            workspace.id,
            workspace.slug || workspace.id,
            workspace.name || workspace.slug || workspace.id,
            workspace.avatar || '',
            workspace.onboardingAgentId || '',
            workspace.newAgentGreetingEnabled !== false,
            workspace.ownerUserId || workspace.owner_user_id || null,
            iso(workspace.deletedAt),
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
                (id, workspace_id, human_id, email, normalized_email, role, token_hash,
                 invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at, metadata)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
              ON CONFLICT (id) DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                human_id = EXCLUDED.human_id,
                email = EXCLUDED.email,
                normalized_email = EXCLUDED.normalized_email,
                role = EXCLUDED.role,
                token_hash = EXCLUDED.token_hash,
                invited_by = EXCLUDED.invited_by,
                expires_at = EXCLUDED.expires_at,
                accepted_at = EXCLUDED.accepted_at,
                accepted_by = EXCLUDED.accepted_by,
                revoked_at = EXCLUDED.revoked_at,
                metadata = EXCLUDED.metadata
            `, [
              invitation.id,
              invitation.workspaceId,
              invitation.humanId || null,
              invitation.email,
              normalizeEmail(invitation.email),
              invitation.role || 'member',
              invitation.tokenHash,
              invitation.invitedBy || null,
              requiredIso(invitation.expiresAt),
              iso(invitation.acceptedAt),
              invitation.acceptedBy || null,
              iso(invitation.revokedAt),
              requiredIso(invitation.createdAt),
              JSON.stringify(jsonObject(invitation.metadata)),
          ]);
        }

        for (const reset of safeArray(cloud.passwordResetTokens)) {
          await client.query(`
            INSERT INTO ${table('cloud_password_resets')}
              (id, workspace_id, user_id, token_hash, created_by, expires_at,
               consumed_at, revoked_at, created_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              user_id = EXCLUDED.user_id,
              token_hash = EXCLUDED.token_hash,
              created_by = EXCLUDED.created_by,
              expires_at = EXCLUDED.expires_at,
              consumed_at = EXCLUDED.consumed_at,
              revoked_at = EXCLUDED.revoked_at,
              metadata = EXCLUDED.metadata
          `, [
            reset.id,
            reset.workspaceId,
            reset.userId,
            reset.tokenHash,
            reset.createdBy || null,
            requiredIso(reset.expiresAt),
            iso(reset.consumedAt),
            iso(reset.revokedAt),
            requiredIso(reset.createdAt),
            JSON.stringify(jsonObject(reset.metadata)),
          ]);
        }

        for (const joinLink of safeArray(cloud.joinLinks)) {
          await client.query(`
            INSERT INTO ${table('cloud_join_links')}
              (id, workspace_id, token_hash, max_uses, used_count, expires_at,
               revoked_at, revoked_by, created_by, created_at, updated_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              token_hash = EXCLUDED.token_hash,
              max_uses = EXCLUDED.max_uses,
              used_count = EXCLUDED.used_count,
              expires_at = EXCLUDED.expires_at,
              revoked_at = EXCLUDED.revoked_at,
              revoked_by = EXCLUDED.revoked_by,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
          `, [
            joinLink.id,
            joinLink.workspaceId,
            joinLink.tokenHash,
            Number(joinLink.maxUses || 0),
            Number(joinLink.usedCount || 0),
            iso(joinLink.expiresAt),
            iso(joinLink.revokedAt),
            joinLink.revokedBy || null,
            joinLink.createdBy || null,
            requiredIso(joinLink.createdAt),
            requiredIso(joinLink.updatedAt || joinLink.createdAt),
            JSON.stringify(jsonObject(joinLink.metadata)),
          ]);
        }

        for (const computer of safeArray(state.computers)) {
          const workspaceId = computer.workspaceId || cloud.workspaces?.[0]?.id;
          if (!workspaceId) continue;
          await client.query(`
            INSERT INTO ${table('cloud_computers')}
              (id, workspace_id, name, hostname, os, arch, daemon_version,
               status, connected_via, runtime_ids, runtime_details, capabilities, running_agents,
               machine_fingerprint, created_by, created_at, updated_at, last_seen_at, daemon_connected_at,
               disconnected_at, disabled_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
              $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              name = EXCLUDED.name,
              hostname = EXCLUDED.hostname,
              os = EXCLUDED.os,
              arch = EXCLUDED.arch,
              daemon_version = EXCLUDED.daemon_version,
              status = EXCLUDED.status,
              connected_via = EXCLUDED.connected_via,
              runtime_ids = EXCLUDED.runtime_ids,
              runtime_details = EXCLUDED.runtime_details,
              capabilities = EXCLUDED.capabilities,
              running_agents = EXCLUDED.running_agents,
              machine_fingerprint = EXCLUDED.machine_fingerprint,
              updated_at = EXCLUDED.updated_at,
              last_seen_at = EXCLUDED.last_seen_at,
              daemon_connected_at = EXCLUDED.daemon_connected_at,
              disconnected_at = EXCLUDED.disconnected_at,
              disabled_at = EXCLUDED.disabled_at,
              metadata = EXCLUDED.metadata
          `, [
            computer.id,
            workspaceId,
            computer.name || computer.hostname || computer.id,
            computer.hostname || '',
            computer.os || '',
            computer.arch || '',
            computer.daemonVersion || '',
            computerStatus(computer.status),
            computer.connectedVia || 'daemon',
            JSON.stringify(safeArray(computer.runtimeIds)),
            JSON.stringify(safeArray(computer.runtimeDetails)),
            JSON.stringify(safeArray(computer.capabilities)),
            JSON.stringify(safeArray(computer.runningAgents)),
            computer.machineFingerprint || computer.fingerprint || '',
            computer.createdBy || null,
            requiredIso(computer.createdAt),
            requiredIso(computer.updatedAt || computer.createdAt),
            iso(computer.lastSeenAt),
            iso(computer.daemonConnectedAt),
            iso(computer.disconnectedAt),
            iso(computer.disabledAt),
            JSON.stringify(jsonObject(computer.metadata)),
          ]);
        }

        for (const token of safeArray(cloud.computerTokens)) {
          await client.query(`
            INSERT INTO ${table('cloud_computer_tokens')}
              (id, workspace_id, computer_id, label, token_hash, created_at,
               last_used_at, expires_at, revoked_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              computer_id = EXCLUDED.computer_id,
              label = EXCLUDED.label,
              token_hash = EXCLUDED.token_hash,
              last_used_at = EXCLUDED.last_used_at,
              expires_at = EXCLUDED.expires_at,
              revoked_at = EXCLUDED.revoked_at,
              metadata = EXCLUDED.metadata
          `, [
            token.id,
            token.workspaceId || cloud.workspaces?.[0]?.id,
            token.computerId,
            token.label || '',
            token.tokenHash,
            requiredIso(token.createdAt),
            iso(token.lastUsedAt),
            iso(token.expiresAt),
            iso(token.revokedAt),
            JSON.stringify(jsonObject(token.metadata)),
          ]);
        }

        for (const pair of safeArray(cloud.pairingTokens)) {
          await client.query(`
            INSERT INTO ${table('cloud_pairing_tokens')}
              (id, workspace_id, computer_id, label, token_hash, created_by,
               created_at, expires_at, consumed_at, revoked_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              computer_id = EXCLUDED.computer_id,
              label = EXCLUDED.label,
              token_hash = EXCLUDED.token_hash,
              created_by = EXCLUDED.created_by,
              expires_at = EXCLUDED.expires_at,
              consumed_at = EXCLUDED.consumed_at,
              revoked_at = EXCLUDED.revoked_at,
              metadata = EXCLUDED.metadata
          `, [
            pair.id,
            pair.workspaceId || cloud.workspaces?.[0]?.id,
            pair.computerId,
            pair.label || '',
            pair.tokenHash,
            pair.createdBy || null,
            requiredIso(pair.createdAt),
            requiredIso(pair.expiresAt),
            iso(pair.consumedAt),
            iso(pair.revokedAt),
            JSON.stringify(jsonObject(pair.metadata)),
          ]);
        }

        for (const delivery of safeArray(cloud.agentDeliveries)) {
          await client.query(`
            INSERT INTO ${table('cloud_agent_deliveries')}
              (id, workspace_id, agent_id, computer_id, message_id, work_item_id,
               seq, type, command_type, status, attempts, payload, error,
               created_at, updated_at, sent_at, acked_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12::jsonb, $13, $14, $15, $16, $17)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              agent_id = EXCLUDED.agent_id,
              computer_id = EXCLUDED.computer_id,
              message_id = EXCLUDED.message_id,
              work_item_id = EXCLUDED.work_item_id,
              seq = EXCLUDED.seq,
              type = EXCLUDED.type,
              command_type = EXCLUDED.command_type,
              status = EXCLUDED.status,
              attempts = EXCLUDED.attempts,
              payload = EXCLUDED.payload,
              error = EXCLUDED.error,
              updated_at = EXCLUDED.updated_at,
              sent_at = EXCLUDED.sent_at,
              acked_at = EXCLUDED.acked_at
          `, [
            delivery.id,
            delivery.workspaceId || cloud.workspaces?.[0]?.id,
            delivery.agentId,
            delivery.computerId,
            delivery.messageId || null,
            delivery.workItemId || null,
            Number(delivery.seq || 0),
            delivery.type || delivery.commandType || '',
            delivery.commandType || delivery.type || '',
            delivery.status || 'queued',
            Number(delivery.attempts || 0),
            JSON.stringify(jsonObject(delivery.payload)),
            delivery.error || '',
            requiredIso(delivery.createdAt),
            requiredIso(delivery.updatedAt || delivery.createdAt),
            iso(delivery.sentAt),
            iso(delivery.ackedAt),
          ]);
        }

        for (const event of safeArray(cloud.daemonEvents)) {
          await client.query(`
            INSERT INTO ${table('cloud_daemon_events')}
              (id, workspace_id, computer_id, type, message, meta, created_at)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              computer_id = EXCLUDED.computer_id,
              type = EXCLUDED.type,
              message = EXCLUDED.message,
              meta = EXCLUDED.meta
          `, [
            event.id,
            event.workspaceId || event.meta?.workspaceId || cloud.workspaces?.[0]?.id || null,
            event.computerId || event.meta?.computerId || null,
            event.type,
            event.message || '',
            JSON.stringify(jsonObject(event.meta)),
            requiredIso(event.createdAt),
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
      const passwordResets = await client.query(`SELECT * FROM ${table('cloud_password_resets')} ORDER BY created_at ASC, id ASC`);
      const joinLinks = await client.query(`SELECT * FROM ${table('cloud_join_links')} ORDER BY created_at ASC, id ASC`);
      const computers = await client.query(`SELECT * FROM ${table('cloud_computers')} ORDER BY created_at ASC, id ASC`);
      const computerTokens = await client.query(`SELECT * FROM ${table('cloud_computer_tokens')} ORDER BY created_at ASC, id ASC`);
      const pairingTokens = await client.query(`SELECT * FROM ${table('cloud_pairing_tokens')} ORDER BY created_at ASC, id ASC`);
      const agentDeliveries = await client.query(`SELECT * FROM ${table('cloud_agent_deliveries')} ORDER BY created_at ASC, id ASC`);
      const daemonEvents = await client.query(`SELECT * FROM ${table('cloud_daemon_events')} ORDER BY created_at DESC, id DESC LIMIT 300`);
      const releaseNotes = await client.query(`SELECT * FROM ${table('cloud_release_notes')} ORDER BY component ASC, released_at DESC, version DESC, category ASC, position ASC`);
      cloud.workspaces = workspaces.rows.map(workspaceFromRow);
      cloud.users = users.rows.map(userFromRow);
      cloud.workspaceMembers = members.rows.map(memberFromRow);
      cloud.sessions = sessions.rows.map(sessionFromRow);
      cloud.invitations = invitations.rows.map(invitationFromRow);
      cloud.passwordResetTokens = passwordResets.rows.map(passwordResetFromRow);
      cloud.joinLinks = joinLinks.rows.map(joinLinkFromRow);
      cloud.computerTokens = computerTokens.rows.map(computerTokenFromRow);
      cloud.pairingTokens = pairingTokens.rows.map(pairingTokenFromRow);
      cloud.agentDeliveries = agentDeliveries.rows.map(agentDeliveryFromRow);
      cloud.daemonEvents = daemonEvents.rows.map(daemonEventFromRow);
      const loadedComputers = computers.rows.map(computerFromRow);
      const loadedComputerIds = new Set(loadedComputers.map((computer) => computer.id));
      const localOnlyComputers = safeArray(state.computers).filter((computer) => (
        computer.id === 'cmp_local' && !loadedComputerIds.has(computer.id)
      ));
      state.computers = [
        ...localOnlyComputers,
        ...loadedComputers,
      ];
      state.releaseNotes = releaseNotesFromRows(releaseNotes.rows, state.releaseNotes);
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
      else await persistReleaseNotesFromState(client, state);
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
