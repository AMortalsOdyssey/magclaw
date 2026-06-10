import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildAgentContextPack,
  renderAgentContextPack,
} from './agent-context.js';
import {
  formatAgentHistory,
  formatAgentSearchResults,
  readAgentHistory,
  searchAgentMessageHistory,
} from './agent-history.js';
import {
  codexRuntimeOverrideForDelivery as codexRuntimeOverrideForDeliveryBase,
  codexStreamRetryLimit,
  codexThreadConfig,
  parseCodexStreamRetry,
  resolveCodexRuntime as resolveCodexRuntimeBase,
} from './codex-runtime.js';
import {
  fanoutApiEndpoint,
  fanoutApiResponseText,
  parseFanoutApiJson,
} from './fanout-api.js';
import {
  applyMentions,
  escapeRegExp,
  extractMentionTokens,
  isMentionBoundaryChar,
  mentionTokenForId,
  normalizeIds,
} from './mentions.js';
import {
  agentCapabilityQuestionIntent,
  agentMemoryWriteIntent,
  agentResponseIntent,
  autoTaskMessageIntent,
  availabilityBroadcastIntent,
  availabilityFollowupIntent,
  channelGreetingIntent,
  contextualAgentFollowupIntent,
  directAvailabilityIntent,
  inferAgentMemoryWriteback,
  inferTaskIntentKind,
  taskCreationIntent,
  taskEndIntent,
  taskStopIntent,
  userPreferenceIntent,
} from './intents.js';
import {
  DEFAULT_FANOUT_API_TIMEOUT_MS,
  fanoutApiConfigReady,
  normalizeChatRuntimeConfig,
  normalizeCloudUrl,
  normalizeCodexModelName as normalizeCodexModelNameBase,
  normalizeFanoutApiConfig as normalizeFanoutApiConfigBase,
  publicApiKeyPreview,
} from './runtime-config.js';
import {
  inferAgentPermissionGrant,
  recordAgentPermissionGrant,
} from './agent-permissions.js';
import {
  inferConversationDisclosureGrant,
  recordConversationGrant,
} from './conversation-grants.js';
import {
  baseNameFromProjectPath,
  CONTENT_TYPES as contentTypes,
  decodePathSegment,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safeFileName,
  safePathWithin,
  splitLines,
  toPosixPath,
} from './path-utils.js';
import {
  listProjectTree as listProjectTreeBase,
  projectFilePreviewKind,
  readProjectFilePreview as readProjectFilePreviewBase,
  searchProject,
  sortProjectSearchResults,
} from './project-files.js';
import { createAgentRuntimeManager } from './agent-runtime-manager.js';
import { createAgentMemoryMirrorManager } from './agent-memory-mirror.js';
import { createAgentWorkspaceManager } from './agent-workspace.js';
import { createConversationModel } from './conversation-model.js';
import { createCollabMemoryManager } from './collab-memory.js';
import { createMarkdownMaintenanceManager } from './markdown-maintenance.js';
import { createMarkdownOperationApplier } from './markdown-operations.js';
import { createCloudAuth } from './cloud/auth.js';
import { createCloudSync } from './cloud-sync.js';
import { createDaemonRelay } from './cloud/daemon-relay.js';
import { createRoutingEngine } from './routing-engine.js';
import { createMissionRunner } from './mission-runner.js';
import { createOnboardingManager } from './onboarding.js';
import { createNpmPackageVersionResolver } from './npm-package-versions.js';
import { createSystemServices } from './system-services.js';
import { createStateCore } from './state-core.js';
import { createTaskOrchestrator } from './task-orchestrator.js';
import { createServerIo } from './server-io.js';
import { createReminderScheduler } from './reminder-scheduler.js';
import { createMailService } from './mail-service.js';
import { createFeishuConnectGateway } from './integrations/feishu-connect/index.js';
import { handleAgentApi } from './api/agent-routes.js';
import { handleAgentToolApi } from './api/agent-tool-routes.js';
import { handleCloudApi } from './api/cloud-routes.js';
import { handleCollabApi } from './api/collab-routes.js';
import { handleMessageApi } from './api/message-routes.js';
import { handleMissionApi } from './api/mission-routes.js';
import { handleProjectApi } from './api/project-routes.js';
import { handleSystemApi } from './api/system-routes.js';
import { handleTaskApi } from './api/task-routes.js';
import { handleTeamSharingApi } from './api/team-sharing-routes.js';
import { handleKnowledgeApi } from './api/knowledge-routes.js';
import { applyServerYamlConfig } from './config-yaml.js';
import {
  createEmbeddingClient,
  createRerankClient,
  createTeamSharingIndexingPipeline,
  createZillizTeamSharingClient,
} from './team-sharing-clients.js';
import { createTeamSharingSummaryClient } from './team-sharing-summary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEB_ASSET_DIR = path.join(PUBLIC_DIR, '.magclaw-assets');
const WEB_ASSET_MANIFEST_FILE = path.join(WEB_ASSET_DIR, 'manifest.json');
const serverConfigLoad = applyServerYamlConfig({ env: process.env });
const LOCAL_FILE_STORAGE_FALLBACK = process.env.MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK !== '0';
const DEFAULT_DATA_DIR = process.env.MAGCLAW_DEPLOYMENT === 'cloud' && LOCAL_FILE_STORAGE_FALLBACK
  ? path.join(ROOT, '.magclaw-local')
  : path.join(os.homedir(), '.magclaw');
const DATA_DIR = path.resolve(process.env.MAGCLAW_DATA_DIR || DEFAULT_DATA_DIR);

function loadLegacyServerEnv() {
  const envPath = path.join(DATA_DIR, 'server.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (!serverConfigLoad.loaded && process.env.MAGCLAW_ALLOW_LEGACY_SERVER_ENV === '1') {
  loadLegacyServerEnv();
}

const DEFAULT_PVC_UPLOAD_DIR = '/var/lib/magclaw/uploads';

function probeWritableDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probePath = path.join(dir, '.magclaw-ready');
    writeFileSync(probePath, new Date().toISOString());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function resolveAttachmentStorage() {
  const requestedMode = String(process.env.MAGCLAW_ATTACHMENT_STORAGE || 'pvc').trim().toLowerCase();
  const fallbackEnabled = process.env.MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK !== '0';
  const requestedUploadDir = String(process.env.MAGCLAW_UPLOAD_DIR || '').trim();
  const pvcDir = path.resolve(requestedUploadDir || DEFAULT_PVC_UPLOAD_DIR);
  const localDir = path.resolve(process.env.MAGCLAW_LOCAL_UPLOAD_DIR || path.join(DATA_DIR, 'attachments'));

  if (requestedMode === 'local') {
    const localProbe = probeWritableDirectory(localDir);
    return {
      mode: 'local',
      requestedMode,
      path: localDir,
      pvcPath: pvcDir,
      writable: localProbe.ok,
      error: localProbe.error || '',
    };
  }

  const pvcProbe = probeWritableDirectory(pvcDir);
  if (pvcProbe.ok) {
    return {
      mode: 'pvc',
      requestedMode,
      path: pvcDir,
      pvcPath: pvcDir,
      writable: true,
      error: '',
    };
  }

  if (!fallbackEnabled) {
    return {
      mode: 'pvc',
      requestedMode,
      path: pvcDir,
      pvcPath: pvcDir,
      writable: false,
      error: pvcProbe.error || 'PVC upload directory is not writable.',
    };
  }

  const localProbe = probeWritableDirectory(localDir);
  const fallbackReason = pvcProbe.error || 'PVC upload directory is not writable.';
  console.warn(`[attachments] PVC upload directory ${pvcDir} is not available (${fallbackReason}); using local attachment storage at ${localDir}.`);
  return {
    mode: 'local',
    requestedMode,
    path: localDir,
    pvcPath: pvcDir,
    writable: localProbe.ok,
    error: localProbe.error || '',
    fallbackReason,
  };
}

const ATTACHMENT_STORAGE = resolveAttachmentStorage();
process.env.MAGCLAW_ATTACHMENT_STORAGE = ATTACHMENT_STORAGE.mode;
process.env.MAGCLAW_UPLOAD_DIR = ATTACHMENT_STORAGE.path;
const ATTACHMENTS_DIR = ATTACHMENT_STORAGE.path;
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const ACTIVITY_LOG_DIR = path.join(DATA_DIR, 'activity-logs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_DB_FILE = path.join(DATA_DIR, 'state.sqlite');
const WRITE_STATE_JSON = /^(1|true|yes)$/i.test(String(process.env.MAGCLAW_WRITE_STATE_JSON || ''));
const SOURCE_CODEX_HOME = path.resolve(process.env.MAGCLAW_CODEX_HOME_SOURCE || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const DEFAULT_PORT = 6543;
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOADS = 20;
const MAX_AGENT_WORKSPACE_TREE_ENTRIES = 300;
const MAX_AGENT_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_RELAY_DEPTH = 2;
const AGENT_BUSY_DELIVERY_DELAY_MS = Math.max(10, Number(process.env.MAGCLAW_AGENT_BUSY_DELIVERY_DELAY_MS || 160));
const AGENT_MAX_ACTIVE_SESSIONS = Math.max(1, Number(process.env.MAGCLAW_AGENT_MAX_ACTIVE_SESSIONS || 2));
const COMPUTER_MAX_ACTIVE_SESSIONS = Math.max(1, Number(process.env.MAGCLAW_COMPUTER_MAX_ACTIVE_SESSIONS || 8));
const AGENT_RUN_STALL_LOG_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_RUN_STALL_LOG_MS || process.env.MAGCLAW_AGENT_RUN_WATCHDOG_STALE_MS || 90_000));
const AGENT_STUCK_SEND_MESSAGE_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS || 15_000));
const AGENT_ACTIVITY_HEARTBEAT_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_ACTIVITY_HEARTBEAT_MS || 60_000));
const AGENT_RUNTIME_PROGRESS_STALE_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_RUNTIME_PROGRESS_STALE_MS || 15 * 60_000));
const STATE_HEARTBEAT_MS = Math.max(25, Number(process.env.MAGCLAW_STATE_HEARTBEAT_MS || 1000));
const STATE_BROADCAST_DEBOUNCE_MS_INPUT = Number(process.env.MAGCLAW_STATE_BROADCAST_DEBOUNCE_MS ?? 80);
const STATE_BROADCAST_DEBOUNCE_MS = Number.isFinite(STATE_BROADCAST_DEBOUNCE_MS_INPUT)
  ? Math.min(1000, Math.max(0, STATE_BROADCAST_DEBOUNCE_MS_INPUT))
  : 80;
const AGENT_STATUS_STALE_MS = Math.max(1000, Number(process.env.MAGCLAW_AGENT_STATUS_STALE_MS || 45_000));
const ROUTE_EVENTS_LIMIT = Math.max(50, Number(process.env.MAGCLAW_ROUTE_EVENTS_LIMIT || 500));
const AGENT_CARD_TEXT_LIMIT = 5000;
const FANOUT_API_TIMEOUT_MS = DEFAULT_FANOUT_API_TIMEOUT_MS;
const MARKDOWN_MAINTENANCE_ENABLED = !/^(0|false|no)$/i.test(String(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_ENABLED || 'true'));
const MARKDOWN_MAINTENANCE_INTERVAL_MS = Math.max(60_000, Number(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_INTERVAL_MS || 6 * 60 * 60_000));
const MARKDOWN_MAINTENANCE_STARTUP_DELAY_MS = Math.max(0, Number(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_STARTUP_DELAY_MS || 120_000));
const MARKDOWN_MAINTENANCE_SEMANTIC = !/^(0|false|no)$/i.test(String(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_SEMANTIC || 'true'));
const MARKDOWN_MAINTENANCE_MAX_AGENTS = Math.max(1, Number(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_MAX_AGENTS || 50));
const MARKDOWN_MAINTENANCE_MAX_FILES_PER_AGENT = Math.max(1, Number(process.env.MAGCLAW_MARKDOWN_MAINTENANCE_MAX_FILES_PER_AGENT || 20));
const AGENT_MEMORY_MIRROR_MIGRATION_ENABLED = /^(1|true|yes)$/i.test(String(process.env.MAGCLAW_AGENT_MEMORY_MIRROR_MIGRATION || ''));
const CODEX_STREAM_RETRY_LIMIT = codexStreamRetryLimit();
const CLOUD_PROTOCOL_VERSION = 1;
const CODEX_HOME_CONFIG_VERSION = 9;
const CODEX_FALLBACK_MODEL = 'gpt-5.5';
const SQLITE_BACKED_STATE_KEYS = ['messages', 'replies', 'tasks', 'reminders', 'workItems', 'events'];
const AGENT_BOOT_RESET_STATUSES = new Set(['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming', 'error']);
const CODEX_HOME_SHARED_ENTRIES = [
  'auth.json',
  'plugins',
  'vendor_imports',
];
const CODEX_HOME_STALE_SHARED_ENTRIES = [
  'config.toml',
  'AGENTS.md',
  'agent-rules',
  'rules',
  'hooks.json',
  'hooks',
];
const runningProcesses = new Map();
const agentProcesses = new Map(); // agentId:conversationLaneKey -> { child, sessionId, status, inbox }
const sseClients = new Set();
const agentCardCache = new Map();

function decodeMountInfoPath(value) {
  return String(value || '').replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountInfoForPath(targetPath) {
  if (process.platform !== 'linux') return null;
  const normalizedTarget = path.resolve(targetPath);
  try {
    const lines = readFileSync('/proc/self/mountinfo', 'utf8').split(/\r?\n/);
    let best = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const separatorIndex = line.indexOf(' - ');
      if (separatorIndex < 0) continue;
      const left = line.slice(0, separatorIndex).split(' ');
      const right = line.slice(separatorIndex + 3).split(' ');
      const mountPoint = path.resolve(decodeMountInfoPath(left[4] || ''));
      const rootMount = mountPoint === path.parse(mountPoint).root;
      const belowMount = rootMount
        ? normalizedTarget.startsWith(mountPoint)
        : normalizedTarget.startsWith(`${mountPoint}${path.sep}`);
      if (normalizedTarget !== mountPoint && !belowMount) {
        continue;
      }
      if (best && mountPoint.length <= best.mountPoint.length) continue;
      best = {
        mountPoint,
        exact: normalizedTarget === mountPoint,
        fsType: right[0] || 'unknown',
        source: right[1] || 'unknown',
      };
    }
    return best;
  } catch {
    return null;
  }
}

function storageStartupSummary() {
  const mount = mountInfoForPath(ATTACHMENTS_DIR);
  const parts = [
    `mode=${ATTACHMENT_STORAGE.mode}`,
    `path=${ATTACHMENTS_DIR}`,
    `requested=${ATTACHMENT_STORAGE.requestedMode}`,
    `writable=${ATTACHMENT_STORAGE.writable ? 'yes' : 'no'}`,
    `pvcPath=${ATTACHMENT_STORAGE.pvcPath}`,
  ];
  if (mount) {
    parts.push(`mount=${mount.mountPoint}`, `mountExact=${mount.exact ? 'yes' : 'no'}`, `fs=${mount.fsType}`, `source=${mount.source}`);
  } else if (process.platform === 'linux') {
    parts.push('mount=not-detected');
  }
  if (ATTACHMENT_STORAGE.fallbackReason) parts.push(`fallback="${ATTACHMENT_STORAGE.fallbackReason}"`);
  if (ATTACHMENT_STORAGE.error) parts.push(`error="${ATTACHMENT_STORAGE.error}"`);
  return parts.join(' ');
}

function logStorageStartupSummary() {
  console.log(`Data directory: ${DATA_DIR}`);
  const message = `[storage] Attachments: ${storageStartupSummary()}`;
  if (ATTACHMENT_STORAGE.writable) {
    console.log(message);
  } else {
    console.warn(message);
  }
  if (ATTACHMENT_STORAGE.mode === 'pvc') {
    console.log(`[storage] PVC attachments enabled at ${ATTACHMENT_STORAGE.pvcPath}`);
  }
}

function envFlagEnabled(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || ''));
}

function postgresStrictlyRequired() {
  return envFlagEnabled('MAGCLAW_REQUIRE_POSTGRES') || envFlagEnabled('MAGCLAW_DATABASE_REQUIRED');
}

function localSqliteStateEnabled() {
  return !(process.env.MAGCLAW_DATABASE_URL && postgresStrictlyRequired());
}

const USE_SQLITE_STATE = localSqliteStateEnabled();
if (!USE_SQLITE_STATE) {
  console.info('[state] PostgreSQL is required and configured; local SQLite state store is disabled.');
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

const SHUTDOWN_DRAIN_MS = Math.max(0, Number(process.env.MAGCLAW_SHUTDOWN_DRAIN_MS || 2500));
let serverDraining = false;
let serverDrainingSince = null;

function isDraining() {
  return serverDraining;
}

const stateCore = createStateCore({
  ensureAllAgentWorkspaces: (...args) => ensureAllAgentWorkspaces(...args),
  extractLocalReferences: (...args) => extractLocalReferences(...args),
  findAgent: (...args) => findAgent(...args),
  agentProcesses,
  makeId,
  normalizeConversationRecord: (...args) => normalizeConversationRecord(...args),
  now,
  publicState: (...args) => publicState(...args),
  publicStateForSse: (...args) => publicBootstrapState(...args),
  queueCloudPush: (...args) => queueCloudPush(...args),
  sseClients,
  targetForConversation: (...args) => targetForConversation(...args),
  taskScopeKey: (...args) => taskScopeKey(...args),
  AGENT_BOOT_RESET_STATUSES,
  AGENT_STATUS_STALE_MS,
  AGENTS_DIR,
  ACTIVITY_LOG_DIR,
  ATTACHMENTS_DIR,
  CLOUD_PROTOCOL_VERSION,
  CODEX_FALLBACK_MODEL,
  CODEX_HOME_CONFIG_VERSION,
  FANOUT_API_TIMEOUT_MS,
  ROOT,
  RUNS_DIR,
  SOURCE_CODEX_HOME,
  SQLITE_BACKED_STATE_KEYS,
  STATE_DB_FILE,
  STATE_FILE,
  STATE_BROADCAST_DEBOUNCE_MS,
  USE_SQLITE_STATE,
  WRITE_STATE_JSON,
});
const state = stateCore.state;
const {
  addRunEvent,
  addSystemEvent,
  agentParticipatesInChannels,
  agentStatusIsBusy,
  broadcast,
  broadcastHeartbeat,
  broadcastState,
  codexRuntimeOverrideForDelivery,
  ensureStorage,
  agentActivityWindow,
  fanoutApiConfigured,
  migrateState,
  normalizeCodexModelName,
  normalizeFanoutApiConfig,
  persistState,
  presenceHeartbeat,
  reconcileAgentStatusHeartbeats,
  realtimeEventsForRequest,
  resolveCodexRuntime,
  recordAgentActivityChanged,
  recordRealtimeEvent,
  setExternalStatePersister,
  setAgentStatus,
  stateJsonSnapshot,
  writePresenceHeartbeat,
} = stateCore;

function localStateFallbackInfo(reason = '') {
  return {
    ok: true,
    enabled: false,
    backend: 'state',
    dataDir: DATA_DIR,
    fallbackReason: reason,
  };
}

function isPostgresIntegrityError(error) {
  return ['23503', '23505', '23514'].includes(String(error?.code || ''));
}

function resilientCloudRepository(repository) {
  if (!repository) return null;
  let disabled = false;
  let fallbackReason = '';

  async function disable(error) {
    fallbackReason = error?.message || String(error || 'PostgreSQL unavailable.');
    disabled = true;
    await repository.close?.().catch(() => {});
    console.warn(`[cloud-postgres] ${fallbackReason}; using local file storage in ${DATA_DIR}.`);
  }

  return {
    async close() {
      await repository.close?.();
    },
    async initialize(stateSnapshot) {
      if (disabled) return localStateFallbackInfo(fallbackReason);
      try {
        return await repository.initialize(stateSnapshot);
      } catch (error) {
        if (postgresStrictlyRequired()) throw error;
        await disable(error);
        return localStateFallbackInfo(fallbackReason);
      }
    },
    isEnabled() {
      return !disabled && Boolean(repository.isEnabled?.());
    },
    async loadIntoState(stateSnapshot) {
      if (disabled) return;
      try {
        await repository.loadIntoState?.(stateSnapshot);
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async loadAuthIntoState(stateSnapshot) {
      if (disabled) return;
      try {
        if (typeof repository.loadAuthIntoState === 'function') {
          await repository.loadAuthIntoState(stateSnapshot);
        } else {
          await repository.loadIntoState?.(stateSnapshot);
        }
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async loadWorkspaceIntoState(stateSnapshot, workspaceId) {
      if (disabled) return;
      try {
        if (typeof repository.loadWorkspaceIntoState === 'function') {
          await repository.loadWorkspaceIntoState(stateSnapshot, workspaceId);
        } else {
          await repository.loadIntoState?.(stateSnapshot);
        }
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async loadConversationWindowIntoState(stateSnapshot, options = {}) {
      if (disabled || typeof repository.loadConversationWindowIntoState !== 'function') return null;
      try {
        return await repository.loadConversationWindowIntoState(stateSnapshot, options);
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
        return null;
      }
    },
    async listSpaceMessagesPage(options = {}) {
      if (disabled || typeof repository.listSpaceMessagesPage !== 'function') return null;
      return repository.listSpaceMessagesPage(options);
    },
    async searchConversationRecords(options = {}) {
      if (disabled || typeof repository.searchConversationRecords !== 'function') return null;
      return repository.searchConversationRecords(options);
    },
    async listThreadRepliesPage(options = {}) {
      if (disabled || typeof repository.listThreadRepliesPage !== 'function') return null;
      return repository.listThreadRepliesPage(options);
    },
    async getMessageById(messageId, options = {}) {
      if (disabled || typeof repository.getMessageById !== 'function') return null;
      return repository.getMessageById(messageId, options);
    },
    async markConversationRecordsRead(options = {}) {
      if (disabled || typeof repository.markConversationRecordsRead !== 'function') return null;
      return repository.markConversationRecordsRead(options);
    },
    async getUnreadCounts(options = {}) {
      if (disabled || typeof repository.getUnreadCounts !== 'function') return null;
      return repository.getUnreadCounts(options);
    },
    async upsertChannelMember(options = {}) {
      if (disabled || typeof repository.upsertChannelMember !== 'function') return null;
      return repository.upsertChannelMember(options);
    },
    async leaveChannelMember(options = {}) {
      if (disabled || typeof repository.leaveChannelMember !== 'function') return null;
      return repository.leaveChannelMember(options);
    },
    async publishRealtimeEvent(payload) {
      if (disabled || typeof repository.publishRealtimeEvent !== 'function') return;
      try {
        await repository.publishRealtimeEvent(payload);
      } catch (error) {
        console.warn(`[cloud-postgres] realtime notify failed message=${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    },
    async subscribeRealtimeEvents(onEvent) {
      if (disabled || typeof repository.subscribeRealtimeEvents !== 'function') return async () => {};
      try {
        return await repository.subscribeRealtimeEvents(onEvent);
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        console.warn(`[cloud-postgres] realtime listener unavailable message=${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`);
        return async () => {};
      }
    },
    async persistFromState(stateSnapshot) {
      if (disabled) return;
      try {
        await repository.persistFromState?.(stateSnapshot);
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async persistWorkspaceFromState(stateSnapshot, workspaceId) {
      if (disabled) return;
      try {
        if (typeof repository.persistWorkspaceFromState === 'function') {
          await repository.persistWorkspaceFromState(stateSnapshot, workspaceId);
        } else {
          await repository.persistFromState?.(stateSnapshot);
        }
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async persistAuthFromState(stateSnapshot) {
      if (disabled) return;
      try {
        if (typeof repository.persistAuthFromState === 'function') {
          await repository.persistAuthFromState(stateSnapshot);
        } else {
          await repository.persistFromState?.(stateSnapshot);
        }
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async persistAuthOperation(operation) {
      if (disabled) return;
      try {
        if (typeof repository.persistAuthOperation === 'function') {
          await repository.persistAuthOperation(operation);
        } else if (operation?.stateSnapshot && typeof repository.persistAuthFromState === 'function') {
          await repository.persistAuthFromState(operation.stateSnapshot);
        } else if (operation?.stateSnapshot && typeof repository.persistFromState === 'function') {
          await repository.persistFromState(operation.stateSnapshot);
        } else {
          throw new Error('Cloud repository does not support auth operation persistence.');
        }
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async deleteComputer(computerId, workspaceId) {
      if (disabled) return;
      try {
        await repository.deleteComputer?.(computerId, workspaceId);
      } catch (error) {
        if (postgresStrictlyRequired() || isPostgresIntegrityError(error)) throw error;
        await disable(error);
      }
    },
    async persistMarkdownDocumentIndex(record) {
      if (disabled || typeof repository.persistMarkdownDocumentIndex !== 'function') return;
      await repository.persistMarkdownDocumentIndex(record);
    },
    async persistMarkdownOperationIndex(record) {
      if (disabled || typeof repository.persistMarkdownOperationIndex !== 'function') return;
      await repository.persistMarkdownOperationIndex(record);
    },
    async persistMarkdownMaintenanceRun(record) {
      if (disabled || typeof repository.persistMarkdownMaintenanceRun !== 'function') return;
      await repository.persistMarkdownMaintenanceRun(record);
    },
    publicInfo() {
      if (disabled) return localStateFallbackInfo(fallbackReason);
      return repository.publicInfo?.() || { backend: 'postgres' };
    },
  };
}

async function createCloudRepositoryFromEnv() {
  if (!process.env.MAGCLAW_DATABASE_URL) {
    if (process.env.MAGCLAW_DEPLOYMENT === 'cloud' && postgresStrictlyRequired()) {
      throw new Error('MAGCLAW_DATABASE_URL is required when MAGCLAW_DEPLOYMENT=cloud.');
    }
    if (process.env.MAGCLAW_DEPLOYMENT === 'cloud') {
      console.warn(`[cloud-postgres] database URL is not configured; using local file storage in ${DATA_DIR}.`);
    }
    return null;
  }
  const { createCloudPostgresStore } = await import('./cloud/postgres-store.js');
  return resilientCloudRepository(createCloudPostgresStore({ attachmentBaseDir: ATTACHMENTS_DIR }));
}

const cloudRepository = await createCloudRepositoryFromEnv();
const npmPackageVersions = createNpmPackageVersionResolver();
const REALTIME_SOURCE_ID = makeId('rt');
let realtimeReloadTimer = null;
let realtimeReloadRunning = false;
let realtimeAuthReloadPending = false;
let realtimeFullReloadPending = false;
const realtimeWorkspaceReloads = new Set();

function scheduleRealtimeReload(event = {}) {
  if (!cloudRepository?.isEnabled?.()) return;
  if (event.sourceId && event.sourceId === REALTIME_SOURCE_ID) return;
  if (event.authReload) realtimeAuthReloadPending = true;
  const workspaceId = String(event.workspaceId || '').trim();
  if (workspaceId && !event.fullReload) {
    realtimeWorkspaceReloads.add(workspaceId);
  } else if (event.fullReload) {
    realtimeFullReloadPending = true;
  }
  if (!event.authReload && !workspaceId && !event.fullReload) realtimeFullReloadPending = true;
  if (realtimeReloadTimer || realtimeReloadRunning) return;
  realtimeReloadTimer = setTimeout(flushRealtimeReload, 50);
  realtimeReloadTimer.unref?.();
}

async function flushRealtimeReload() {
  realtimeReloadTimer = null;
  if (realtimeReloadRunning) return;
  realtimeReloadRunning = true;
  const authReload = realtimeAuthReloadPending;
  const fullReload = realtimeFullReloadPending;
  const workspaceIds = [...realtimeWorkspaceReloads];
  realtimeAuthReloadPending = false;
  realtimeFullReloadPending = false;
  realtimeWorkspaceReloads.clear();
  try {
    if (fullReload) {
      await cloudRepository.loadIntoState?.(state);
    } else {
      if (authReload) {
        await cloudRepository.loadAuthIntoState?.(state);
      }
      if (typeof cloudRepository.loadWorkspaceIntoState === 'function') {
        for (const workspaceId of workspaceIds) {
          await cloudRepository.loadWorkspaceIntoState(state, workspaceId);
        }
      } else if (workspaceIds.length) {
        await cloudRepository.loadIntoState?.(state);
      }
    }
    broadcastState({ skipCloudPush: true });
  } catch (error) {
    console.warn(`[cloud-postgres] realtime reload failed message=${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`);
  } finally {
    realtimeReloadRunning = false;
    if (realtimeAuthReloadPending || realtimeFullReloadPending || realtimeWorkspaceReloads.size) {
      realtimeReloadTimer = setTimeout(flushRealtimeReload, 50);
      realtimeReloadTimer.unref?.();
    }
  }
}

const mailService = createMailService();
let scheduleHumanOnboardingFromCloud = null;
const cloudAuth = createCloudAuth({
  cloudRepository,
  getState: () => state,
  mailService,
  makeId,
  normalizeIds,
  now,
  persistState,
  realtimeSourceId: REALTIME_SOURCE_ID,
  scheduleHumanOnboarding: (...args) => scheduleHumanOnboardingFromCloud?.(...args),
});

async function hydrateBootstrapWindow(req, options = {}) {
  if (!cloudRepository?.isEnabled?.() || typeof cloudRepository.loadConversationWindowIntoState !== 'function') return null;
  const actor = cloudAuth.currentActor(req);
  const workspaceId = String(
    actor?.member?.workspaceId
    || state.connection?.workspaceId
    || state.cloud?.workspace?.id
    || '',
  ).trim();
  return cloudRepository.loadConversationWindowIntoState(state, {
    workspaceId,
    spaceType: options.spaceType,
    spaceId: options.spaceId,
    threadMessageId: options.threadMessageId,
    messageLimit: options.messageLimit,
    replyLimit: options.replyLimit || options.messageLimit,
  });
}

const serverIo = createServerIo({
  addSystemEvent,
  getState: () => state,
  makeId,
  now,
  ATTACHMENTS_DIR,
  MAX_JSON_BYTES,
});
const {
  extractLocalReferences,
  findProject,
  listProjectTree,
  localReferenceLines,
  projectReferenceFromParts,
  projectsForSpace,
  readJson,
  readProjectFilePreview,
  requireCloudAccess,
  requireCloudDeploymentApi,
  saveAttachmentBuffer,
  searchProjectItems,
  sendError,
  sendJson,
} = serverIo;

const conversationModel = createConversationModel({
  getState: () => state,
  httpError,
  makeId,
  now,
  extractLocalReferences,
  projectReferenceFromParts,
});
const {
  addSystemMessage,
  addTaskTimelineMessage,
  agentAvailableForAutoWork,
  agentIdleForAvailability,
  defaultReadBy,
  deliveryMessageMatchesScope,
  deliveryMessageMatchesTask,
  encodeVisibleMentions,
  extractMentions,
  findActor,
  findAgent,
  findChannel,
  findChannelByRef,
  findComputer,
  findConversationRecord,
  findDmByRef,
  findHuman,
  findMessage,
  findMessageByRef,
  findMission,
  findReply,
  findRun,
  findTask,
  findTaskForThreadMessage,
  findWorkItem,
  knownMentionEntries,
  messageMatchesScope,
  messageMatchesTask,
  nextTaskNumber,
  normalizeConversationRecord,
  prepareAgentResponseBody,
  renderMentionsForAgent,
  replaceBareActorIds,
  resolveConversationSpace,
  resolveMessageTarget,
  runMatchesScope,
  runMatchesTask,
  selectedDefaultSpaceId,
  shortTaskId,
  spaceDisplayName,
  spaceMatchesScope,
  stopScopeFromBody,
  targetForConversation,
  taskIsClosed,
  taskLabel,
  taskMatchesScope,
  taskScopeKey,
  taskThreadRecordIds,
  turnMetaAllWorkStopped,
  turnMetaHasStoppedWork,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  visibleMentionLabel,
  workItemIsStopped,
  workItemMatchesScope,
  workItemMatchesTask,
} = conversationModel;

async function deploymentHealth() {
  if (isDraining()) {
    return {
      ok: false,
      draining: true,
      drainingSince: serverDrainingSince,
      service: 'magclaw-web',
      deployment: state.connection?.deployment || process.env.MAGCLAW_DEPLOYMENT || 'local',
      time: now(),
    };
  }
  const attachmentProbe = {
    mode: ATTACHMENT_STORAGE.mode,
    requestedMode: ATTACHMENT_STORAGE.requestedMode,
    path: ATTACHMENTS_DIR,
    pvcPath: ATTACHMENT_STORAGE.pvcPath,
    fallbackReason: ATTACHMENT_STORAGE.fallbackReason || '',
    writable: false,
  };
  try {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    const probePath = path.join(ATTACHMENTS_DIR, '.magclaw-ready');
    await writeFile(probePath, now());
    attachmentProbe.writable = true;
  } catch (error) {
    attachmentProbe.error = error.message;
  }
  const postgresRequired = process.env.MAGCLAW_DEPLOYMENT === 'cloud' && postgresStrictlyRequired();
  const postgresConfigured = Boolean(process.env.MAGCLAW_DATABASE_URL);
  return {
    ok: attachmentProbe.writable && (!postgresRequired || postgresConfigured),
    service: 'magclaw-web',
    deployment: state.connection?.deployment || process.env.MAGCLAW_DEPLOYMENT || 'local',
    storage: {
      postgres: {
        required: postgresRequired,
        configured: postgresConfigured,
        enabled: Boolean(cloudRepository?.isEnabled?.()),
        fallback: !cloudRepository?.isEnabled?.(),
        backend: cloudRepository?.isEnabled?.() ? 'postgres' : 'state',
      },
      attachments: attachmentProbe,
    },
    time: now(),
  };
}

const daemonRelay = createDaemonRelay({
  addSystemEvent,
  AGENT_STATUS_STALE_MS,
  broadcastState,
  cloudAuth,
  findAgent,
  findComputer,
  getState: () => state,
  host: HOST,
  isDraining,
  makeId,
  normalizeConversationRecord,
  now,
  persistCloudState: cloudAuth.persistCloudState,
  persistState,
  port: PORT,
  recordAgentActivityChanged,
  recordRealtimeEvent,
  root: ROOT,
  setAgentStatus,
});

let feishuConnectGateway = null;
async function syncExternalThreadReply(reply, options = {}) {
  if (!feishuConnectGateway?.syncReply) return { skipped: true, reason: 'feishu_gateway_unavailable' };
  return feishuConnectGateway.syncReply(reply, options);
}

function beginDrain(reason = 'manual') {
  if (serverDraining) return { ok: true, draining: true, drainingSince: serverDrainingSince };
  serverDraining = true;
  serverDrainingSince = now();
  addSystemEvent('server_draining', 'MagClaw server is draining before shutdown.', {
    reason,
    drainingSince: serverDrainingSince,
  });
  daemonRelay.beginDrain?.(reason);
  for (const res of sseClients) {
    try {
      res.write(`event: state-resync-required\ndata: ${JSON.stringify({
        type: 'server_draining',
        reason,
        draining: true,
        createdAt: serverDrainingSince,
      })}\n\n`);
      res.end();
    } catch {
      sseClients.delete(res);
    }
  }
  persistState().then(broadcastState).catch(() => {});
  return { ok: true, draining: true, drainingSince: serverDrainingSince };
}

const agentWorkspace = createAgentWorkspaceManager({
  addSystemEvent,
  channelAgentIds: (...args) => channelAgentIds(...args),
  getState: () => state,
  now,
  AGENTS_DIR,
  CODEX_HOME_CONFIG_VERSION,
  CODEX_HOME_SHARED_ENTRIES,
  CODEX_HOME_STALE_SHARED_ENTRIES,
  MAX_AGENT_WORKSPACE_FILE_BYTES,
  MAX_AGENT_WORKSPACE_TREE_ENTRIES,
  SOURCE_CODEX_HOME,
});
const {
  agentDataDir,
  ensureAgentWorkspace,
  ensureAllAgentWorkspaces,
  listAgentMemoryFiles,
  listAgentSkills,
  listAgentWorkspace,
  prepareAgentCodexHome,
  prepareAgentRuntimeHooks,
  readAgentMemoryFile,
  readAgentWorkspaceFile,
  searchAgentMemory,
  writeAgentSessionFile,
} = agentWorkspace;

const agentMemoryMirror = createAgentMemoryMirrorManager({
  addSystemEvent,
  enabled: ATTACHMENT_STORAGE.mode === 'pvc' && ATTACHMENT_STORAGE.writable,
  rootDir: process.env.MAGCLAW_AGENT_MEMORY_MIRROR_DIR
    || path.join(ATTACHMENT_STORAGE.pvcPath || ATTACHMENTS_DIR, 'agent-memory'),
  now,
});
const {
  listAgentMemoryMirrorWorkspace,
  materializeAgentMemoryMirror,
  migrateAgentMemoryMirror,
  readAgentMemoryMirrorFile,
} = agentMemoryMirror;

const markdownApplier = createMarkdownOperationApplier({
  addSystemEvent,
  defaultAgentMemory: agentWorkspace.defaultAgentMemory,
  ensureAgentWorkspace,
  makeId,
  materializeMarkdownMirror: materializeAgentMemoryMirror,
  now,
  persistMarkdownDocumentIndex: (...args) => cloudRepository?.persistMarkdownDocumentIndex?.(...args),
  persistMarkdownOperationIndex: (...args) => cloudRepository?.persistMarkdownOperationIndex?.(...args),
});

function recordSessionSummaryLlmIssue(issue = {}) {
  const message = '会话总结的 LLM 异常';
  const workspaceId = String(issue.workspaceId || issue.agent?.workspaceId || state.cloud?.workspace?.id || 'local');
  const nowIso = now();
  const existing = (state.systemNotifications || []).find((item) => (
    item
    && String(item.event || item.type || '') === 'session_summary_llm_error'
    && String(item.workspaceId || '') === workspaceId
  ));
  if (existing) {
    existing.message = message;
    existing.updatedAt = nowIso;
    existing.lastSeenAt = nowIso;
    existing.occurrenceCount = Math.max(1, Number(existing.occurrenceCount || 1)) + 1;
  } else {
    state.systemNotifications = Array.isArray(state.systemNotifications) ? state.systemNotifications : [];
    state.systemNotifications.push({
      id: makeId('sys'),
      type: 'system_warning',
      event: 'session_summary_llm_error',
      workspaceId,
      message,
      severity: 'warning',
      createdAt: nowIso,
      updatedAt: nowIso,
      occurrenceCount: 1,
    });
    if (state.systemNotifications.length > 500) {
      state.systemNotifications.splice(0, state.systemNotifications.length - 500);
    }
  }
  return persistState({ workspaceId, reason: 'session_summary_llm_error' }).then(broadcastState).catch((error) => {
    console.error(`[markdown-maintenance] failed to persist LLM issue notification workspace=${workspaceId}`, error);
  });
}

const markdownMaintenance = createMarkdownMaintenanceManager({
  addSystemEvent,
  ensureAgentWorkspace,
  logLlmIssue: (message, detail) => console.error(message, detail),
  makeId,
  now,
  persistMarkdownMaintenanceRun: (...args) => cloudRepository?.persistMarkdownMaintenanceRun?.(...args),
  reportLlmIssue: recordSessionSummaryLlmIssue,
  submitAgentMarkdownOperation: markdownApplier.submitAgentMarkdownOperation,
});

const routingEngine = createRoutingEngine({
  addSystemEvent,
  agentAvailableForAutoWork,
  agentCardCache,
  agentDataDir,
  agentIdleForAvailability,
  agentParticipatesInChannels,
  findAgent,
  findChannel,
  findHuman,
  findTask,
  findTaskForThreadMessage,
  getState: () => state,
  makeId,
  now,
  renderMentionsForAgent,
  spaceDisplayName,
  taskIsClosed,
  taskLabel,
  visibleMentionLabel,
  AGENT_CARD_TEXT_LIMIT,
  FANOUT_API_TIMEOUT_MS,
  ROUTE_EVENTS_LIMIT,
});
const {
  buildAgentCards,
  channelAgentIds,
  channelHumanIds,
  cleanTaskTitle,
  determineRespondingAgents,
  displayActor,
  pickAvailableAgent,
  routeTaskAssignees,
  routeMessageForChannel,
  routeThreadReplyForChannel,
  shouldAgentRespond,
  textAddressesAgent,
  threadParticipantAgentIds,
  uniqueAgents,
} = routingEngine;

const collabMemory = createCollabMemoryManager({
  addSystemEvent,
  agentCardCache,
  broadcastState,
  channelAgentIds,
  defaultAgentMemory: agentWorkspace.defaultAgentMemory,
  displayActor,
  ensureAgentWorkspace,
  findMessage,
  getState: () => state,
  makeId,
  normalizeConversationRecord,
  now,
  persistState,
  spaceDisplayName,
  submitAgentMarkdownOperation: markdownApplier.submitAgentMarkdownOperation,
  taskLabel,
});
const {
  addCollabEvent,
  addSystemReply,
  addTaskHistory,
  normalizeName,
  scheduleAgentMemoryWriteback,
  writeAgentMemoryUpdate,
} = collabMemory;

const taskOrchestrator = createTaskOrchestrator({
  addCollabEvent,
  addTaskHistory,
  addTaskTimelineMessage,
  stopWorkItemsForTask: (...args) => stopWorkItemsForTask(...args),
  claimTask: (...args) => claimTask(...args),
  cleanTaskTitle,
  createTaskFromMessage: (...args) => createTaskFromMessage(...args),
  createTaskMessage: (...args) => createTaskMessage(...args),
  displayActor,
  findMessage,
  getState: () => state,
  makeId,
  normalizeConversationRecord,
  now,
  renderMentionsForAgent,
  spaceDisplayName,
  steerAgentProcessesForTaskStop: (...args) => steerAgentProcessesForTaskStop(...args),
  stopRunsForTask: (...args) => stopRunsForTask(...args),
  taskIsClosed,
  taskLabel,
});
const {
  createOrClaimTaskForMessage,
  createTaskFromThreadIntent,
  ensureTaskThread,
  finishTaskFromThread,
  shouldStartThreadForAgentDelivery,
  stopTaskFromThread,
  taskAssignmentDeliveryMessage,
  taskThreadDeliveryMessage,
} = taskOrchestrator;

const cloudSync = createCloudSync({
  getState: () => state,
  migrateState,
  now,
  persistState,
  CLOUD_PROTOCOL_VERSION,
});
const {
  applyCloudSnapshot,
  cloudFetch,
  cloudSnapshot,
  pullStateFromCloud,
  pushStateToCloud,
  queueCloudPush,
} = cloudSync;

const systemServices = createSystemServices({
  addSystemEvent,
  broadcastState,
  fanoutApiConfigured,
  getState: () => state,
  httpError,
  makeId,
  now,
  npmPackageVersions,
  persistState,
  publicCloudState: (req) => cloudAuth.publicCloudState(req),
  projectsForSpace,
  runningProcesses,
  selectedDefaultSpaceId,
  DATA_DIR,
  PORT,
  ROOT,
});
const {
  addProjectFolder,
  detectInstalledRuntimes,
  execFileResult,
  execText,
  getRuntimeInfo,
  pickFolderPath,
  packageUpdateSnapshot,
  packageVersionSnapshot,
  publicConnection,
  publicBootstrapState,
  publicDirectoryState,
  publicDirectorySearchState,
  publicMembersDirectoryState,
  publicState,
  startPackageVersionPolling,
  stopPackageVersionPolling,
  updateFanoutApiConfig,
} = systemServices;

const missionRunner = createMissionRunner({
  addRunEvent,
  addSystemReply,
  addTaskHistory,
  addTaskTimelineMessage,
  broadcastState,
  displayActor,
  ensureTaskThread,
  findTask,
  getState: () => state,
  localReferenceLines,
  now,
  persistState,
  runningProcesses,
  ROOT,
  RUNS_DIR,
  taskLabel,
});
const { startCodexRun } = missionRunner;

const agentRuntime = createAgentRuntimeManager({
  addCollabEvent,
  addSystemEvent,
  addSystemReply,
  addTaskHistory,
  addTaskTimelineMessage,
  agentAvailableForAutoWork,
  agentDataDir,
  agentProcesses,
  attachmentStorageDir: ATTACHMENTS_DIR,
  autoTaskMessageIntent,
  broadcastState,
  channelAgentIds,
  channelHumanIds,
  cloudRelay: daemonRelay,
  CODEX_STREAM_RETRY_LIMIT,
  codexRuntimeOverrideForDelivery,
  deliveryMessageMatchesScope,
  deliveryMessageMatchesTask,
  displayActor,
  ensureAgentWorkspace,
  ensureTaskThread,
  extractLocalReferences,
  extractMentions,
  findAgent,
  findChannel,
  findConversationRecord,
  findHuman,
  findMessage,
  findMission,
  findRun,
  findTask,
  findTaskForThreadMessage,
  findWorkItem,
  getState: () => state,
  HOST,
  httpError,
  localReferenceLines,
  makeId,
  MAX_AGENT_RELAY_DEPTH,
  normalizeConversationRecord,
  now,
  nextTaskNumber,
  persistState,
  pickAvailableAgent,
  prepareAgentCodexHome,
  prepareAgentRuntimeHooks,
  prepareAgentResponseBody,
  projectsForSpace,
  recordAgentActivityChanged,
  recordRealtimeEvent,
  renderMentionsForAgent,
  resolveCodexRuntime,
  resolveConversationSpace,
  resolveMessageTarget,
  runMatchesTask,
  ROOT,
  runningProcesses,
  RUNS_DIR,
  scheduleAgentMemoryWriteback,
  setAgentStatus,
  shouldStartThreadForAgentDelivery,
  spaceDisplayName,
  syncExternalThreadReply,
  spaceMatchesScope,
  taskIsClosed,
  taskLabel,
  taskMatchesScope,
  targetForConversation,
  turnMetaAllWorkStopped,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  writeAgentSessionFile,
  workItemMatchesScope,
  workItemMatchesTask,
  AGENT_BUSY_DELIVERY_DELAY_MS,
  AGENT_MAX_ACTIVE_SESSIONS,
  COMPUTER_MAX_ACTIVE_SESSIONS,
  AGENT_RUN_STALL_LOG_MS,
  AGENT_STUCK_SEND_MESSAGE_MS,
  AGENT_ACTIVITY_HEARTBEAT_MS,
  AGENT_RUNTIME_PROGRESS_STALE_MS,
  PORT,
});

const {
  getAgentRuntime,
  createAgentStandingPrompt,
  createAgentTurnPrompt,
  startAgentProcess,
  startClaudeAgent,
  startCodexAgent,
  sendCodexAppServerRequest,
  sendCodexAppServerNotification,
  triggerCodexStreamRetryFallback,
  handleCodexThreadReady,
  startCodexAppServerTurn,
  sendCodexAppServerMessages,
  clearAgentBusyDeliveryTimer,
  queueCodexBusyDelivery,
  scheduleCodexBusyDelivery,
  flushCodexPendingDeliveries,
  handleCodexTurnCompleted,
  handleCodexAppServerLine,
  fallbackToCodexExec,
  startCodexAgentLegacy,
  restartAgentWithQueuedMessages,
  partitionMessagesByScope,
  partitionMessagesByTask,
  stopWorkItemsForScope,
  stopWorkItemsForTask,
  activeTurnMetas,
  activeDeliveryMessagesOutsideTask,
  uniqueDeliveryMessages,
  processHasOnlyScopedActiveWork,
  processHasActiveTaskWork,
  stopAgentProcessForScope,
  stopAgentProcessForTask,
  stopAgentProcesses,
  stopAgentProcessesForTask,
  steerAgentProcessesForTaskStop,
  stopRunsForScope,
  stopRunsForTask,
  waitForAgentProcessExit,
  stopAgentProcessForControl,
  resetAgentRuntimeSession,
  resetAgentWorkspaceFiles,
  startAgentFromControl,
  warmAgentFromControl,
  restartAgentFromControl,
  agentAlreadyRoutedForSource,
  relayAgentMentions,
  inferTaskIdForDelivery,
  createWorkItemForDelivery,
  markWorkItemsDelivered,
  turnMetaHasExplicitSend,
  workItemTargetMatches,
  markWorkItemResponded,
  markFallbackResponseWorkItem,
  markFallbackResponseWorkItems,
  upsertAgentResponseStream,
  postAgentResponse,
  deliverMessageToAgent,
  createTaskFromMessage,
  createTaskMessage,
  claimTask,
  findTaskForAgentTool,
  updateTaskForAgent,
} = agentRuntime;

const onboardingManager = createOnboardingManager({
  addSystemEvent,
  addSystemMessage,
  agentAvailableForAutoWork,
  broadcastState,
  deliverMessageToAgent,
  findAgent,
  getState: () => state,
  makeId,
  normalizeIds,
  now,
  persistState,
});
const {
  scheduleHumanOnboarding,
  scheduleNewAgentGreeting,
} = onboardingManager;
scheduleHumanOnboardingFromCloud = (...args) => scheduleHumanOnboarding(...args);

const reminderScheduler = createReminderScheduler({
  addSystemEvent,
  addSystemMessage,
  addSystemReply,
  broadcastState,
  deliverMessageToAgent,
  findAgent,
  findMessage,
  getState: () => state,
  makeId,
  now,
  persistState,
  resolveMessageTarget,
  targetForConversation,
});
const {
  cancelReminder,
  createReminder,
  fireDueReminders,
  listReminders,
  start: startReminderScheduler,
  stop: stopReminderScheduler,
} = reminderScheduler;

let markdownMaintenanceTimer = null;
let markdownMaintenanceRunning = false;

async function runMarkdownMaintenanceSweep(reason = 'interval') {
  if (!MARKDOWN_MAINTENANCE_ENABLED) return { ok: true, skipped: 'disabled' };
  if (markdownMaintenanceRunning) return { ok: true, skipped: 'already_running' };
  markdownMaintenanceRunning = true;
  const agents = (state.agents || [])
    .filter((agent) => agent?.id)
    .slice(0, MARKDOWN_MAINTENANCE_MAX_AGENTS);
  let processed = 0;
  let changed = 0;
  let failed = 0;
  try {
    for (const agent of agents) {
      const files = await listAgentMemoryFiles(agent, { includeDetailed: true })
        .catch((error) => {
          failed += 1;
          addSystemEvent('markdown_maintenance_list_error', `Markdown maintenance could not list memory files for ${agent.name || agent.id}: ${error.message}`, {
            agentId: agent.id,
            workspaceId: agent.workspaceId || 'local',
          });
          return ['MEMORY.md'];
        });
      for (const relPath of files.slice(0, MARKDOWN_MAINTENANCE_MAX_FILES_PER_AGENT)) {
        const result = await markdownMaintenance.maintainAgentMarkdown(agent, relPath, {
          semantic: MARKDOWN_MAINTENANCE_SEMANTIC,
        }).catch((error) => {
          failed += 1;
          addSystemEvent('markdown_maintenance_error', `Markdown maintenance failed for ${agent.name || agent.id} ${relPath}: ${error.message}`, {
            agentId: agent.id,
            workspaceId: agent.workspaceId || 'local',
            relPath,
          });
          return null;
        });
        if (!result) continue;
        processed += 1;
        if (result.deterministicChanged || result.semantic === 'applied') changed += 1;
      }
    }
    if (changed || failed) {
      addSystemEvent('markdown_maintenance_sweep', 'Markdown maintenance sweep completed.', {
        reason,
        processed,
        changed,
        failed,
        agents: agents.length,
      });
      await persistState().then(broadcastState).catch(() => {});
    }
    return { ok: failed === 0, processed, changed, failed };
  } finally {
    markdownMaintenanceRunning = false;
  }
}

async function runAgentMemoryMirrorMigration(reason = 'startup') {
  if (!AGENT_MEMORY_MIRROR_MIGRATION_ENABLED) return { ok: true, skipped: 'disabled' };
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const agent of state.agents || []) {
    if (!agent?.id) continue;
    if (agent.memoryMirrorMigration?.migratedAt) {
      skipped += 1;
      continue;
    }
    const legacyWorkspacePath = String(agent.workspacePath || '').trim();
    if (!legacyWorkspacePath) {
      skipped += 1;
      continue;
    }
    try {
      const result = await migrateAgentMemoryMirror({
        agent,
        legacyWorkspacePath,
        defaultAgentMemory: agentWorkspace.defaultAgentMemory,
        clearLegacyWorkspace: async () => {
          agent.workspacePath = null;
          agent.workspace = null;
        },
      });
      migrated += 1;
      addSystemEvent('agent_memory_mirror_migrated', `Migrated ${agent.name || agent.id} MEMORY.md to cloud mirror.`, {
        agentId: agent.id,
        workspaceId: agent.workspaceId || 'local',
        source: result.source,
        hash: result.hash,
        reason,
      });
      await persistState({ workspaceId: agent.workspaceId || 'local', reason: 'agent_memory_mirror_migrated' });
    } catch (error) {
      failed += 1;
      console.warn('[agent-memory-mirror] migration failed', {
        agentId: agent.id,
        workspaceId: agent.workspaceId || 'local',
        error: error.message,
      });
      addSystemEvent('agent_memory_mirror_migration_error', `Could not migrate ${agent.name || agent.id} MEMORY.md: ${error.message}`, {
        agentId: agent.id,
        workspaceId: agent.workspaceId || 'local',
        reason,
      });
    }
  }
  if (migrated || failed) {
    addSystemEvent('agent_memory_mirror_migration_sweep', 'Agent memory mirror migration completed.', {
      reason,
      migrated,
      skipped,
      failed,
    });
  }
  return { ok: failed === 0, migrated, skipped, failed };
}

function scheduleNextMarkdownMaintenance(delayMs) {
  if (!MARKDOWN_MAINTENANCE_ENABLED) return;
  clearTimeout(markdownMaintenanceTimer);
  markdownMaintenanceTimer = setTimeout(async () => {
    await runMarkdownMaintenanceSweep('interval').catch((error) => {
      addSystemEvent('markdown_maintenance_scheduler_error', `Markdown maintenance scheduler failed: ${error.message}`);
      persistState().then(broadcastState).catch(() => {});
    });
    scheduleNextMarkdownMaintenance(MARKDOWN_MAINTENANCE_INTERVAL_MS);
  }, delayMs);
  markdownMaintenanceTimer.unref?.();
}

function startMarkdownMaintenanceScheduler() {
  scheduleNextMarkdownMaintenance(MARKDOWN_MAINTENANCE_STARTUP_DELAY_MS);
}

function stopMarkdownMaintenanceScheduler() {
  clearTimeout(markdownMaintenanceTimer);
  markdownMaintenanceTimer = null;
}

daemonRelay.setHandlers({
  onAgentMessageDelta: async ({ agent, body, spaceType, spaceId, parentMessageId, sourceMessage, deliveryId, idempotencyKey }) => {
    await upsertAgentResponseStream(agent, spaceType, spaceId, body, parentMessageId, {
      sourceMessage,
      deliveryId,
      idempotencyKey,
      streamId: deliveryId || idempotencyKey || '',
      source: 'daemon-runtime',
    });
  },
  onAgentMessage: async ({ agent, body, spaceType, spaceId, parentMessageId, sourceMessage, deliveryId, idempotencyKey }) => {
    const posted = await postAgentResponse(agent, spaceType, spaceId, body, parentMessageId, {
      sourceMessage,
      deliveryId,
      idempotencyKey,
      dedupeWindowMs: deliveryId || idempotencyKey ? 3 * 1000 : 0,
    });
    if (markFallbackResponseWorkItem(sourceMessage, posted)) {
      await persistState({
        workspaceId: posted?.workspaceId || agent.workspaceId || state.connection?.workspaceId || '',
        reason: 'daemon_agent_message_created',
      });
      broadcastState();
    }
  },
});

function projectApiDeps() {
  return {
    addProjectFolder,
    addSystemEvent,
    beginDrain,
    broadcastState,
    decodePathSegment,
    defaultWorkspace: ROOT,
    findProject,
    getState: () => state,
    isDraining,
    listProjectTree,
    maxAttachmentUploads: MAX_ATTACHMENT_UPLOADS,
    persistState,
    pickFolderPath,
    readJson,
    readProjectFilePreview,
    saveAttachmentBuffer,
    searchProjectItems,
    selectedDefaultSpaceId,
    sendError,
    sendJson,
    attachmentStorageDir: ATTACHMENTS_DIR,
    currentActor: (req) => cloudAuth.currentActor(req),
  };
}

function cloudApiDeps() {
  return {
    addSystemEvent,
    applyCloudSnapshot,
    broadcastState,
    cloudFetch,
    cloudSnapshot,
    cloudAuth,
    daemonRelay,
    dataDir: DATA_DIR,
    getState: () => state,
    host: HOST,
    normalizeCloudUrl,
    now,
    persistState,
    port: PORT,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    publicConnection,
    pullStateFromCloud,
    pushStateToCloud,
    readJson,
    requireCloudAccess,
    sendError,
    sendJson,
  };
}

function systemApiDeps() {
  return {
    addSystemEvent,
    beginDrain,
    broadcastState,
    cloudAuth,
    deploymentHealth,
    defaultWorkspace: ROOT,
    detectInstalledRuntimes,
    fanoutApiConfigured,
    getRuntimeInfo,
    getState: () => state,
    hydrateBootstrapWindow,
    isDraining,
    persistState,
    presenceHeartbeat,
    packageUpdateSnapshot,
    packageVersionSnapshot,
    publicBootstrapState,
    publicDirectoryState,
    publicDirectorySearchState,
    publicMembersDirectoryState,
    publicState,
    readJson,
    sendError,
    sendJson,
    shareImageDownloadDir: process.env.MAGCLAW_SHARE_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads'),
    realtimeEventsForRequest,
    sseClients,
    updateFanoutApiConfig,
    writePresenceHeartbeat,
  };
}

function appApiAuthIsBypassed(url) {
  return url.pathname.startsWith('/api/cloud/')
    || url.pathname.startsWith('/api/auth/')
    || url.pathname.startsWith('/api/team-sharing/')
    || url.pathname.startsWith('/api/knowledge/')
    || url.pathname.startsWith('/api/console/')
    || url.pathname === '/api/healthz'
    || url.pathname === '/api/readyz';
}

function requiredRolesForAppApi(req, url) {
  if (req.method === 'GET') return [];
  if (['PATCH', 'POST'].includes(req.method) && /^\/api\/humans\/[^/]+$/.test(url.pathname)) return [];
  if (req.method === 'POST' && (
    url.pathname === '/api/attachments'
    || url.pathname === '/api/dms'
    || /^\/api\/channels\/[^/]+\/feishu-import-path$/.test(url.pathname)
    || url.pathname === '/api/inbox/read'
    || /^\/api\/spaces\/(channel|dm)\/[^/]+\/messages$/.test(url.pathname)
    || /^\/api\/messages\/[^/]+\/replies$/.test(url.pathname)
    || /^\/api\/agents\/[^/]+\/warm$/.test(url.pathname)
  )) return [];
  if (url.pathname === '/api/settings' || url.pathname === '/api/settings/fanout') return ['admin'];
  return ['admin'];
}

function requireAppApiAccess(req, res, url) {
  if (!cloudAuth.isLoginRequired()) return true;
  if (url.pathname.startsWith('/api/agent-tools/')) {
    if (req.daemonAuth) return true;
    sendError(res, 401, 'Machine token is required for cloud agent tools.');
    return false;
  }
  if (appApiAuthIsBypassed(url)) return true;
  if (
    req.method === 'GET'
    && (url.pathname === '/api/state' || url.pathname === '/api/bootstrap')
    && cloudAuth.currentUser(req)
  ) return true;
  return Boolean(cloudAuth.requireUser(req, res, sendError, requiredRolesForAppApi(req, url)));
}

function collabApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    daemonRelay,
    findAgent,
    findChannel,
    findComputer,
    currentActor: (req) => cloudAuth.currentActor(req),
    getState: () => state,
    loadWorkspaceIntoState: typeof cloudRepository?.loadWorkspaceIntoState === 'function'
      ? (...args) => cloudRepository.loadWorkspaceIntoState(...args)
      : null,
    makeId,
    normalizeConversationRecord,
    normalizeIds,
    normalizeName,
    now,
    persistState,
    readJson,
    upsertChannelMember: typeof cloudRepository?.upsertChannelMember === 'function'
      ? (...args) => cloudRepository.upsertChannelMember(...args)
      : null,
    leaveChannelMember: typeof cloudRepository?.leaveChannelMember === 'function'
      ? (...args) => cloudRepository.leaveChannelMember(...args)
      : null,
    scheduleAgentMemoryWriteback,
    sendError,
    sendJson,
  };
}

function teamSharingApiDeps() {
  const embeddingClient = createEmbeddingClient();
  const zillizClient = createZillizTeamSharingClient();
  const rerankClient = createRerankClient();
  const summaryClient = createTeamSharingSummaryClient();
  const workspaceIdFromActor = (actor) => String(
    actor?.member?.workspaceId
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || 'local',
  ).trim();
  const bearerToken = (req) => String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const zillizConfigured = () => Boolean(
    process.env.MAGCLAW_ZILLIZ_ENDPOINT
      && process.env.MAGCLAW_ZILLIZ_TOKEN,
  );
  const safeTokenEqual = (left, right) => {
    const cleanLeft = String(left || '');
    const cleanRight = String(right || '');
    if (!cleanLeft || !cleanRight) return false;
    const leftBuffer = Buffer.from(cleanLeft);
    const rightBuffer = Buffer.from(cleanRight);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  };
  return {
    addSystemEvent,
    broadcastState,
    currentActor: (req) => cloudAuth.currentActor(req),
    currentUser: (req) => cloudAuth.currentUser(req),
    embeddingProbe: () => embeddingClient.probeDimension(),
    embeddingReady: () => Boolean(
      process.env.MAGCLAW_EMBEDDING_BASE_URL
        && process.env.MAGCLAW_EMBEDDING_API_KEY
        && process.env.MAGCLAW_EMBEDDING_MODEL,
    ),
    getState: () => state,
    loadWorkspaceIntoState: typeof cloudRepository?.loadWorkspaceIntoState === 'function'
      ? (...args) => cloudRepository.loadWorkspaceIntoState(...args)
      : null,
    indexTeamSharingDocuments: ({ documents }) => createTeamSharingIndexingPipeline({
      embeddingClient,
      zillizClient,
    }).indexDocuments({ documents }),
    makeId,
    now,
    persistState,
    readJson,
    rerank: ({ query, candidates, limit }) => rerankClient.rerank({ query, candidates, limit }),
    saveAttachmentBuffer,
    sendError,
    sendJson,
    summarizeSession: (input) => summaryClient.summarizeSession(input),
    attachmentStorageDir: ATTACHMENTS_DIR,
    teamSharingAuthRequired: () => (
      /^(1|true|yes)$/i.test(String(process.env.MAGCLAW_TEAM_SHARING_REQUIRE_AUTH || ''))
      || process.env.MAGCLAW_DEPLOYMENT === 'cloud'
    ),
    upsertChannelMember: typeof cloudRepository?.upsertChannelMember === 'function'
      ? (...args) => cloudRepository.upsertChannelMember(...args)
      : null,
    validTeamSharingToken: (req) => {
      const expected = process.env.MAGCLAW_TEAM_SHARING_SYNC_TOKEN || '';
      return safeTokenEqual(bearerToken(req), expected);
    },
    keywordSearch: async ({ query, keywordQuery, keywords, topics, channelId, excludeChannelId, projectKey, dateRange, limit, actor, workspaceId }) => {
      try {
        if (typeof zillizClient.keywordSearch !== 'function') return { ok: false, code: 'keyword_search_unavailable' };
        return zillizClient.keywordSearch({
          query,
          keywordQuery,
          keywords,
          topics,
          workspaceId: workspaceId || workspaceIdFromActor(actor),
          channelId,
          excludeChannelId,
          projectKey,
          dateRange,
          limit,
        });
      } catch (error) {
        return { ok: false, error: error?.message || 'Team sharing keyword search failed.' };
      }
    },
    keywordSearchReady: zillizConfigured,
    vectorSearch: async ({ query, channelId, excludeChannelId, projectKey, dateRange, limit, actor, workspaceId }) => {
      try {
        const embedded = await embeddingClient.embed(query || '');
        return zillizClient.search({
          queryVector: embedded.embedding,
          workspaceId: workspaceId || workspaceIdFromActor(actor),
          channelId,
          excludeChannelId,
          projectKey,
          dateRange,
          limit,
        });
      } catch (error) {
        return { ok: false, error: error?.message || 'Team sharing vector search failed.' };
      }
    },
    zillizReady: zillizConfigured,
    rerankReady: () => Boolean(process.env.MAGCLAW_RERANK_URL && process.env.MAGCLAW_RERANK_API_KEY),
  };
}

function knowledgeApiDeps() {
  return {
    addSystemEvent,
    broadcastState,
    currentActor: (req) => cloudAuth.currentActor(req),
    currentUser: (req) => cloudAuth.currentUser(req),
    env: process.env,
    fetchImpl: globalThis.fetch,
    getState: () => state,
    isLoginRequired: () => cloudAuth.isLoginRequired(),
    makeId,
    now,
    persistState,
    readJson,
    sendError,
    sendJson,
  };
}

function agentToolApiDeps() {
  return {
    addSystemEvent,
    addTaskHistory,
    broadcastState,
    claimTask,
    cancelReminder,
    createTaskFromMessage,
    createTaskMessage,
    createReminder,
    deliverMessageToAgent,
    displayActor,
    findAgent,
    findConversationRecord,
    findMessage,
    findTaskForAgentTool,
    findWorkItem,
    formatAgentHistory,
    formatAgentSearchResults,
    getState: () => state,
    httpError,
    makeId,
    markWorkItemResponded,
    normalizeConversationRecord,
    normalizeIds,
    now,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readAgentMemoryFile,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    listReminders,
    routeTaskAssignees,
    scheduleAgentMemoryWriteback,
    searchAgentMessageHistory,
    searchAgentMemory,
    sendError,
    sendJson,
    submitAgentMarkdownOperation: markdownApplier.submitAgentMarkdownOperation,
    taskLabel,
    taskAssignmentDeliveryMessage,
    updateTaskForAgent,
    writeAgentMemoryUpdate,
    workItemTargetMatches,
    attachmentStorageDir: ATTACHMENTS_DIR,
  };
}

function missionApiDeps() {
  return {
    addRunEvent,
    addSystemEvent,
    broadcastState,
    findMission,
    findRun,
    getRunningProcess: (runId) => runningProcesses.get(runId),
    getState: () => state,
    makeId,
    now,
    persistState,
    readJson,
    root: ROOT,
    sendError,
    sendJson,
    splitLines,
    startCodexRun,
  };
}

function taskApiDeps() {
  return {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    claimTask,
    createTaskMessage,
    deliverMessageToAgent,
    displayActor,
    ensureTaskThread,
    findAgent,
    findTask,
    getState: () => state,
    makeId,
    normalizeIds,
    now,
    persistState,
    readJson,
    resolveConversationSpace,
    routeTaskAssignees,
    root: ROOT,
    sendError,
    sendJson,
    startCodexRun,
    taskAssignmentDeliveryMessage,
    taskIsClosed,
    taskLabel,
  };
}

function agentApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    clearAgentProcesses: () => agentProcesses.clear(),
    currentActor: (req) => cloudAuth.currentActor(req),
    ensureAgentWorkspace,
    findAgent,
    findChannel,
    findComputer,
    getState: () => state,
    hasAgentProcess: (agentId) => [...agentProcesses.values()].some((proc) => proc?.agentId === agentId),
    listAgentActivity: (...args) => agentActivityWindow(...args),
    listAgentMemoryMirrorWorkspace,
    listAgentWorkspace,
    listAgentSkills,
    makeId,
    normalizeCodexModelName,
    normalizeIds,
    now,
    persistState,
    readAgentMemoryMirrorFile,
    readAgentWorkspaceFile,
    readJson,
    requestAgentWorkspaceFile: (...args) => daemonRelay.requestAgentWorkspaceFile(...args),
    requestAgentWorkspaceList: (...args) => daemonRelay.requestAgentWorkspaceList(...args),
    requestAgentSkills: (...args) => daemonRelay.requestAgentSkills(...args),
    restartAgentFromControl,
    root: ROOT,
    scheduleNewAgentGreeting,
    sendError,
    sendJson,
    setAgentStatus,
    startAgentFromControl,
    warmAgentFromControl,
    stopAgentProcesses,
    stopRunsForScope,
    stopScopeFromBody,
  };
}

function messageApiDeps() {
  return {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    addTaskHistory,
    agentAvailableForAutoWork,
    agentCapabilityQuestionIntent,
    agentMemoryWriteIntent,
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    channelHumanIds,
    claimTask,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskMessage,
    createTaskFromThreadIntent,
    currentActor: (req) => cloudAuth.currentActor(req),
    deliverMessageToAgent,
    displayActor,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findHuman,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState: () => state,
    getMessageById: typeof cloudRepository?.getMessageById === 'function'
      ? (...args) => cloudRepository.getMessageById(...args)
      : null,
    inferAgentMemoryWriteback,
    inferAgentPermissionGrant,
    inferConversationDisclosureGrant,
    listSpaceMessagesPage: typeof cloudRepository?.listSpaceMessagesPage === 'function'
      ? (...args) => cloudRepository.listSpaceMessagesPage(...args)
      : null,
    searchConversationRecords: typeof cloudRepository?.searchConversationRecords === 'function'
      ? (...args) => cloudRepository.searchConversationRecords(...args)
      : null,
    listThreadRepliesPage: typeof cloudRepository?.listThreadRepliesPage === 'function'
      ? (...args) => cloudRepository.listThreadRepliesPage(...args)
      : null,
    markConversationRecordsRead: typeof cloudRepository?.markConversationRecordsRead === 'function'
      ? (...args) => cloudRepository.markConversationRecordsRead(...args)
      : null,
    getUnreadCounts: typeof cloudRepository?.getUnreadCounts === 'function'
      ? (...args) => cloudRepository.getUnreadCounts(...args)
      : null,
    makeId,
    normalizeIds,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeTaskAssignees,
    routeThreadReplyForChannel,
    recordRealtimeEvent,
    recordAgentPermissionGrant,
    recordConversationGrant,
    scheduleAgentMemoryWriteback,
    searchAgentMemory,
    sendError,
    sendJson,
    stopTaskFromThread,
    syncExternalThreadReply,
    taskAssignmentDeliveryMessage,
    taskCreationIntent,
    taskEndIntent,
    taskStopIntent,
    taskThreadDeliveryMessage,
    taskLabel,
    textAddressesAgent,
    userPreferenceIntent,
  };
}

function feishuConnectDeps() {
  return {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    channelAgentIds,
    claimTask,
    createTaskFromMessage,
    deliverMessageToAgent,
    displayActor,
    findAgent,
    findChannel,
    findHuman,
    findMessage,
    getState: () => state,
    loadWorkspaceIntoState: typeof cloudRepository?.loadWorkspaceIntoState === 'function'
      ? (...args) => cloudRepository.loadWorkspaceIntoState(...args)
      : null,
    makeId,
    normalizeConversationRecord,
    normalizeIds,
    now,
    persistState,
    routeTaskAssignees,
    saveAttachmentBuffer,
    scheduleAgentMemoryWriteback,
    taskAssignmentDeliveryMessage,
    taskLabel,
  };
}

function startFeishuConnectGateway() {
  createFeishuConnectGateway(feishuConnectDeps()).then((gateway) => {
    feishuConnectGateway = gateway;
  }).catch((error) => {
    addSystemEvent('feishu_connect_start_failed', `Feishu Connect Gateway failed to start: ${error?.message || error}`);
    persistState().then(broadcastState).catch(() => {});
  });
}

async function handleApi(req, res, url) {
  const daemonToolAuth = url.pathname.startsWith('/api/agent-tools/')
    ? daemonRelay.authenticateHttpRequest(req)
    : null;
  if (daemonToolAuth) req.daemonAuth = daemonToolAuth;
  if (!daemonToolAuth && !requireCloudDeploymentApi(req, res, url)) return true;
  if (!requireAppApiAccess(req, res, url)) return true;

  if (await handleSystemApi(req, res, url, systemApiDeps())) return true;

  if (await handleAgentToolApi(req, res, url, agentToolApiDeps())) return true;

  if (await handleMissionApi(req, res, url, missionApiDeps())) return true;

  if (await handleTaskApi(req, res, url, taskApiDeps())) return true;

  if (await handleAgentApi(req, res, url, agentApiDeps())) return true;

  if (await handleCloudApi(req, res, url, cloudApiDeps())) return true;

  if (await handleProjectApi(req, res, url, projectApiDeps())) return true;

  if (await handleCollabApi(req, res, url, collabApiDeps())) return true;

  if (await handleKnowledgeApi(req, res, url, knowledgeApiDeps())) return true;

  if (await handleTeamSharingApi(req, res, url, teamSharingApiDeps())) return true;

  if (await handleMessageApi(req, res, url, messageApiDeps())) return true;

  return false;
}

function readWebAssetManifest() {
  try {
    const manifest = JSON.parse(readFileSync(WEB_ASSET_MANIFEST_FILE, 'utf8'));
    const script = String(manifest?.assets?.script || '');
    const style = String(manifest?.assets?.style || '');
    if (!script.startsWith('/.magclaw-assets/') || !style.startsWith('/.magclaw-assets/')) return null;
    return { script, style };
  } catch {
    return null;
  }
}

function renderAppIndexHtml() {
  const source = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const manifest = readWebAssetManifest();
  if (!manifest) return source;
  return source
    .replace(/^\s*<link rel="stylesheet" href="\/app\/release-settings\.css" \/>\s*\n?/m, '')
    .replace(
      /<link rel="stylesheet" href="\/styles\.css" \/>/,
      `<link rel="stylesheet" href="${manifest.style}" />`,
    )
    .replace(
      /<script type="module" src="\/app\.js"><\/script>/,
      `<script defer src="${manifest.script}"></script>`,
    );
}

function staticCacheControl(pathname, filePath, isAppShell = false) {
  const ext = path.extname(filePath).toLowerCase();
  if (isAppShell || ext === '.html') return 'no-cache, must-revalidate';
  if (/^\/\.magclaw-assets\/(?:app|style)-[a-f0-9]{12}\.(?:js|css)$/.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (
    pathname.startsWith('/brand/')
    || pathname.startsWith('/avatars/')
    || /^\/(?:favicon\.ico|apple-touch-icon\.png|android-chrome-\d+x\d+\.png|favicon-\d+x\d+\.png)$/.test(pathname)
  ) {
    return 'public, max-age=31536000, immutable';
  }
  if (['.js', '.css'].includes(ext)) return 'no-cache, must-revalidate';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2'].includes(ext)) {
    return 'public, max-age=86400, stale-while-revalidate=604800';
  }
  return 'no-cache, must-revalidate';
}

function compressibleStaticPath(filePath) {
  return ['.js', '.css', '.html', '.svg', '.json'].includes(path.extname(filePath).toLowerCase());
}

function precompressedAsset(req, filePath) {
  if (!compressibleStaticPath(filePath)) return null;
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(acceptEncoding) && existsSync(`${filePath}.br`)) {
    return { filePath: `${filePath}.br`, encoding: 'br' };
  }
  if (/\bgzip\b/.test(acceptEncoding) && existsSync(`${filePath}.gz`)) {
    return { filePath: `${filePath}.gz`, encoding: 'gzip' };
  }
  return null;
}

function sendAppShell(res) {
  const html = renderAppIndexHtml();
  res.writeHead(200, {
    'content-type': contentTypes.get('.html') || 'text/html; charset=utf-8',
    'cache-control': staticCacheControl('/index.html', path.join(PUBLIC_DIR, 'index.html'), true),
  });
  res.end(html);
}

function safeAppReturnTo(url) {
  const target = `${url?.pathname || '/'}${url?.search || ''}`;
  return target.startsWith('/') && !target.startsWith('//') ? target : '/console';
}

function redirectAppShellLogin(res, url) {
  res.writeHead(302, {
    location: `/?returnTo=${encodeURIComponent(safeAppReturnTo(url))}`,
    'cache-control': 'no-store',
  });
  res.end('');
}

function shouldRedirectUnauthenticatedWorkspaceDeepLink(req, url) {
  if (!cloudAuth.isLoginRequired()) return false;
  if (cloudAuth.currentUser(req)) return false;
  return /^\/s\/[^/]+\/.+/.test(url.pathname || '');
}

async function serveStatic(req, res, url) {
  if (shouldRedirectUnauthenticatedWorkspaceDeepLink(req, url)) {
    redirectAppShellLogin(res, url);
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  const appShellRequest = pathname === '/' || pathname === '/index.html';
  if (appShellRequest) {
    sendAppShell(res);
    return;
  }
  const requestedPath = safePathWithin(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!requestedPath) {
    sendError(res, 403, 'Forbidden.');
    return;
  }

  let filePath = requestedPath;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    sendAppShell(res);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const compressed = precompressedAsset(req, filePath);
  const headers = {
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
    'cache-control': staticCacheControl(pathname, filePath),
  };
  if (compressed) {
    headers['content-encoding'] = compressed.encoding;
    headers.vary = 'accept-encoding';
  } else if (compressibleStaticPath(filePath)) {
    headers.vary = 'accept-encoding';
  }
  res.writeHead(200, headers);
  createReadStream(compressed?.filePath || filePath).pipe(res);
}

async function handleRequest(req, res) {
  res.magclawRequest = req;
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname === '/login/device') {
      if (!(await handleCloudApi(req, res, url, cloudApiDeps()))) sendError(res, 404, 'Route not found.');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'API route not found.');
      return;
    }
    if (
      url.pathname.startsWith('/team-sharing/')
      || url.pathname.startsWith('/s/')
      || url.pathname === '/share'
      || url.pathname.startsWith('/share/')
    ) {
      if (await handleTeamSharingApi(req, res, url, teamSharingApiDeps())) return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, error.message || 'Internal server error.');
  }
}

await ensureStorage();
await cloudAuth.initializeStorage();
await runAgentMemoryMirrorMigration('startup');
if (cloudRepository?.isEnabled?.() && typeof cloudRepository.subscribeRealtimeEvents === 'function') {
  await cloudRepository.subscribeRealtimeEvents(scheduleRealtimeReload).catch((error) => {
    console.warn(`[cloud-postgres] realtime listener startup failed message=${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`);
  });
}
setExternalStatePersister(async (stateSnapshot, options = {}) => {
  if (cloudRepository?.isEnabled?.()) {
    const workspaceId = String(options.workspaceId || options.externalWorkspaceId || '').trim();
    const deletedComputerId = String(options.deletedComputerId || '').trim();
    if (deletedComputerId && workspaceId && typeof cloudRepository.deleteComputer === 'function') {
      await cloudRepository.deleteComputer(deletedComputerId, workspaceId);
    }
    if (workspaceId && typeof cloudRepository.persistWorkspaceFromState === 'function') {
      await cloudRepository.persistWorkspaceFromState(stateSnapshot, workspaceId);
      await cloudRepository.publishRealtimeEvent?.({
        sourceId: REALTIME_SOURCE_ID,
        workspaceId,
        reason: options.reason || 'workspace_state_changed',
      });
      return;
    }
    await cloudRepository.persistFromState?.(stateSnapshot);
    await cloudRepository.publishRealtimeEvent?.({
      sourceId: REALTIME_SOURCE_ID,
      reason: options.reason || 'state_changed',
      fullReload: true,
    });
  }
});

function expectedSocketClose(error) {
  const code = String(error?.code || error?.errno || '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function upgradeRequestPath(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`).pathname;
  } catch {
    return 'unknown';
  }
}

function safeUpgradeEnd(socket, response) {
  try {
    if (socket?.destroyed) return;
    socket.end(response);
  } catch {
    try {
      socket?.destroy?.();
    } catch {
      // Ignore cleanup failures on already-reset sockets.
    }
  }
}

const server = http.createServer(handleRequest);
server.on('upgrade', (req, socket) => {
  socket.on('error', (error) => {
    if (expectedSocketClose(error)) return;
    const code = String(error?.code || error?.errno || 'UNKNOWN');
    const message = String(error?.message || error || 'Upgrade socket error').replace(/\s+/g, ' ').slice(0, 300);
    console.warn(`[server] upgrade socket error path=${upgradeRequestPath(req)} code=${code} message=${message}`);
  });
  daemonRelay.handleUpgrade(req, socket).then((handled) => {
    if (!handled) {
      safeUpgradeEnd(socket, 'HTTP/1.1 404 Not Found\r\n\r\n');
    }
  }).catch((error) => {
    const message = String(error?.message || 'WebSocket upgrade failed.').replace(/[\r\n]+/g, ' ');
    safeUpgradeEnd(socket, `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\n${message}`);
  });
});
const heartbeatTimer = setInterval(() => {
  const daemonActivityProbe = daemonRelay.probeStaleAgentHeartbeats?.();
  if (daemonActivityProbe?.waitingForProbe) {
    if (daemonActivityProbe.changed) persistState().then(broadcastState).catch(() => {});
    return;
  }
  if (reconcileAgentStatusHeartbeats()) {
    persistState().then(broadcastState).catch(() => {});
    return;
  }
  if (sseClients.size) broadcastHeartbeat();
}, STATE_HEARTBEAT_MS);
heartbeatTimer.unref?.();

server.listen(PORT, HOST, () => {
  addSystemEvent('server_started', `Magclaw local server started at http://${HOST}:${PORT}`);
  startPackageVersionPolling?.();
  startReminderScheduler();
  startMarkdownMaintenanceScheduler();
  startFeishuConnectGateway();
  fireDueReminders().catch((error) => {
    addSystemEvent('reminder_startup_fire_error', `Startup reminder check failed: ${error.message}`);
    persistState().then(broadcastState).catch(() => {});
  });
  persistState().then(broadcastState);
  console.log(`Magclaw local is running at http://${HOST}:${PORT}`);
  logStorageStartupSummary();
});

let shutdownStarted = false;
function shutdown(signal = 'SIGTERM') {
  if (shutdownStarted) return;
  shutdownStarted = true;
  beginDrain(String(signal || 'signal').toLowerCase());
  const drainMs = signal === 'SIGTERM' ? SHUTDOWN_DRAIN_MS : 0;
  const forceExit = setTimeout(() => process.exit(0), drainMs + 5000);
  forceExit.unref?.();
  setTimeout(() => {
    clearInterval(heartbeatTimer);
    feishuConnectGateway?.stop?.();
    stopPackageVersionPolling?.();
    stopReminderScheduler();
    stopMarkdownMaintenanceScheduler();
    for (const child of runningProcesses.values()) child.kill('SIGTERM');
    for (const proc of agentProcesses.values()) {
      if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
    }
    server.close(async () => {
      try {
        await cloudAuth.close?.();
        await cloudRepository?.close?.();
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    });
    server.closeAllConnections?.();
  }, drainMs).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
