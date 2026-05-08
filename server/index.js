import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
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
import { createAgentWorkspaceManager } from './agent-workspace.js';
import { createConversationModel } from './conversation-model.js';
import { createCollabMemoryManager } from './collab-memory.js';
import { createCloudAuth } from './cloud/auth.js';
import { createCloudSync } from './cloud-sync.js';
import { createDaemonRelay } from './cloud/daemon-relay.js';
import { createRoutingEngine } from './routing-engine.js';
import { createMissionRunner } from './mission-runner.js';
import { createSystemServices } from './system-services.js';
import { createStateCore } from './state-core.js';
import { createTaskOrchestrator } from './task-orchestrator.js';
import { createServerIo } from './server-io.js';
import { createReminderScheduler } from './reminder-scheduler.js';
import { createMailService } from './mail-service.js';
import { handleAgentApi } from './api/agent-routes.js';
import { handleAgentToolApi } from './api/agent-tool-routes.js';
import { handleCloudApi } from './api/cloud-routes.js';
import { handleCollabApi } from './api/collab-routes.js';
import { handleMessageApi } from './api/message-routes.js';
import { handleMissionApi } from './api/mission-routes.js';
import { handleProjectApi } from './api/project-routes.js';
import { handleSystemApi } from './api/system-routes.js';
import { handleTaskApi } from './api/task-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.MAGCLAW_DATA_DIR || path.join(os.homedir(), '.magclaw'));

function loadLocalServerEnv() {
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

loadLocalServerEnv();

const ATTACHMENTS_DIR = path.resolve(process.env.MAGCLAW_UPLOAD_DIR || path.join(DATA_DIR, 'attachments'));
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_DB_FILE = path.join(DATA_DIR, 'state.sqlite');
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
const AGENT_RUN_STALL_LOG_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_RUN_STALL_LOG_MS || process.env.MAGCLAW_AGENT_RUN_WATCHDOG_STALE_MS || 90_000));
const AGENT_STUCK_SEND_MESSAGE_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS || 15_000));
const AGENT_ACTIVITY_HEARTBEAT_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_ACTIVITY_HEARTBEAT_MS || 60_000));
const AGENT_RUNTIME_PROGRESS_STALE_MS = Math.max(250, Number(process.env.MAGCLAW_AGENT_RUNTIME_PROGRESS_STALE_MS || 15 * 60_000));
const STATE_HEARTBEAT_MS = Math.max(25, Number(process.env.MAGCLAW_STATE_HEARTBEAT_MS || 1000));
const AGENT_STATUS_STALE_MS = Math.max(1000, Number(process.env.MAGCLAW_AGENT_STATUS_STALE_MS || 45_000));
const ROUTE_EVENTS_LIMIT = Math.max(50, Number(process.env.MAGCLAW_ROUTE_EVENTS_LIMIT || 500));
const AGENT_CARD_TEXT_LIMIT = 5000;
const FANOUT_API_TIMEOUT_MS = Math.max(500, Number(process.env.MAGCLAW_FANOUT_TIMEOUT_MS || DEFAULT_FANOUT_API_TIMEOUT_MS));
const CODEX_STREAM_RETRY_LIMIT = codexStreamRetryLimit();
const CLOUD_PROTOCOL_VERSION = 1;
const CODEX_HOME_CONFIG_VERSION = 7;
const CODEX_FALLBACK_MODEL = 'gpt-5.5';
const SQLITE_BACKED_STATE_KEYS = ['messages', 'replies', 'tasks', 'reminders', 'workItems', 'events'];
const AGENT_BOOT_RESET_STATUSES = new Set(['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'error']);
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
const agentProcesses = new Map(); // agentId -> { child, sessionId, status, inbox }
const sseClients = new Set();
const agentCardCache = new Map();

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
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
  queueCloudPush: (...args) => queueCloudPush(...args),
  sseClients,
  targetForConversation: (...args) => targetForConversation(...args),
  taskScopeKey: (...args) => taskScopeKey(...args),
  AGENT_BOOT_RESET_STATUSES,
  AGENT_STATUS_STALE_MS,
  AGENTS_DIR,
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
  fanoutApiConfigured,
  migrateState,
  normalizeCodexModelName,
  normalizeFanoutApiConfig,
  persistState,
  presenceHeartbeat,
  reconcileAgentStatusHeartbeats,
  resolveCodexRuntime,
  setAgentStatus,
  stateJsonSnapshot,
} = stateCore;

async function createCloudRepositoryFromEnv() {
  if (!process.env.MAGCLAW_DATABASE_URL && !process.env.DATABASE_URL) {
    if (process.env.MAGCLAW_DEPLOYMENT === 'cloud') {
      throw new Error('MAGCLAW_DATABASE_URL or DATABASE_URL is required when MAGCLAW_DEPLOYMENT=cloud.');
    }
    return null;
  }
  const { createCloudPostgresStore } = await import('./cloud/postgres-store.js');
  return createCloudPostgresStore();
}

const cloudRepository = await createCloudRepositoryFromEnv();
const mailService = createMailService();
const cloudAuth = createCloudAuth({
  cloudRepository,
  getState: () => state,
  mailService,
  makeId,
  normalizeIds,
  now,
  persistState,
});

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
  const attachmentMode = process.env.MAGCLAW_ATTACHMENT_STORAGE || (process.env.MAGCLAW_UPLOAD_DIR ? 'pvc' : 'local');
  const attachmentProbe = {
    mode: attachmentMode,
    path: ATTACHMENTS_DIR,
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
  const postgresRequired = process.env.MAGCLAW_DEPLOYMENT === 'cloud';
  const postgresConfigured = Boolean(process.env.MAGCLAW_DATABASE_URL || process.env.DATABASE_URL);
  return {
    ok: attachmentProbe.writable && (!postgresRequired || postgresConfigured),
    service: 'magclaw-web',
    deployment: state.connection?.deployment || process.env.MAGCLAW_DEPLOYMENT || 'local',
    storage: {
      postgres: {
        required: postgresRequired,
        configured: postgresConfigured,
        enabled: Boolean(cloudRepository?.isEnabled?.()),
      },
      attachments: attachmentProbe,
    },
    time: now(),
  };
}

const daemonRelay = createDaemonRelay({
  addSystemEvent,
  broadcastState,
  cloudAuth,
  findAgent,
  findComputer,
  getState: () => state,
  host: HOST,
  makeId,
  normalizeConversationRecord,
  now,
  persistState,
  port: PORT,
  root: ROOT,
  setAgentStatus,
});

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
  listAgentSkills,
  listAgentWorkspace,
  prepareAgentCodexHome,
  readAgentMemoryFile,
  readAgentWorkspaceFile,
  searchAgentMemory,
  writeAgentSessionFile,
} = agentWorkspace;

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
  publicConnection,
  publicState,
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
  prepareAgentResponseBody,
  projectsForSpace,
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
  postAgentResponse,
  deliverMessageToAgent,
  createTaskFromMessage,
  createTaskMessage,
  claimTask,
  findTaskForAgentTool,
  updateTaskForAgent,
} = agentRuntime;

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

daemonRelay.setHandlers({
  onAgentMessage: async ({ agent, body, spaceType, spaceId, parentMessageId, sourceMessage }) => {
    await postAgentResponse(agent, spaceType, spaceId, body, parentMessageId, { sourceMessage });
  },
});

function projectApiDeps() {
  return {
    addProjectFolder,
    addSystemEvent,
    broadcastState,
    decodePathSegment,
    defaultWorkspace: ROOT,
    findProject,
    getState: () => state,
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
    broadcastState,
    cloudAuth,
    deploymentHealth,
    defaultWorkspace: ROOT,
    detectInstalledRuntimes,
    fanoutApiConfigured,
    getRuntimeInfo,
    getState: () => state,
    persistState,
    presenceHeartbeat,
    publicState,
    readJson,
    sendError,
    sendJson,
    sseClients,
    updateFanoutApiConfig,
  };
}

function appApiAuthIsBypassed(url) {
  return url.pathname.startsWith('/api/cloud/')
    || url.pathname.startsWith('/api/auth/')
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
    || url.pathname === '/api/inbox/read'
    || /^\/api\/spaces\/(channel|dm)\/[^/]+\/messages$/.test(url.pathname)
    || /^\/api\/messages\/[^/]+\/replies$/.test(url.pathname)
    || /^\/api\/agents\/[^/]+\/warm$/.test(url.pathname)
  )) return [];
  if (url.pathname === '/api/settings' || url.pathname === '/api/settings/fanout') return ['admin'];
  return ['core_member'];
}

function requireAppApiAccess(req, res, url) {
  if (!cloudAuth.isLoginRequired()) return true;
  if (url.pathname.startsWith('/api/agent-tools/')) {
    if (req.daemonAuth) return true;
    sendError(res, 401, 'Machine token is required for cloud agent tools.');
    return false;
  }
  if (appApiAuthIsBypassed(url)) return true;
  if (req.method === 'GET' && url.pathname === '/api/state' && cloudAuth.currentUser(req)) return true;
  return Boolean(cloudAuth.requireUser(req, res, sendError, requiredRolesForAppApi(req, url)));
}

function collabApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    findAgent,
    findChannel,
	    findComputer,
	    currentActor: (req) => cloudAuth.currentActor(req),
	    getState: () => state,
    makeId,
    normalizeConversationRecord,
    normalizeIds,
    normalizeName,
    now,
    persistState,
    readJson,
    scheduleAgentMemoryWriteback,
    sendError,
    sendJson,
  };
}

function agentToolApiDeps() {
  return {
    addSystemEvent,
    broadcastState,
    claimTask,
    cancelReminder,
    createTaskFromMessage,
    createTaskMessage,
    createReminder,
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
    normalizeIds,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readAgentMemoryFile,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    listReminders,
    searchAgentMessageHistory,
    searchAgentMemory,
    sendError,
    sendJson,
    taskLabel,
    updateTaskForAgent,
    writeAgentMemoryUpdate,
    workItemTargetMatches,
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
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    claimTask,
    createTaskMessage,
    displayActor,
    ensureTaskThread,
    findTask,
    getState: () => state,
    makeId,
    normalizeIds,
    now,
    persistState,
    readJson,
    resolveConversationSpace,
    root: ROOT,
    sendError,
    sendJson,
    startCodexRun,
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
    ensureAgentWorkspace,
    findAgent,
    findChannel,
    getState: () => state,
    hasAgentProcess: (agentId) => agentProcesses.has(agentId),
    listAgentWorkspace,
    listAgentSkills,
    makeId,
    normalizeCodexModelName,
    normalizeIds,
    now,
    persistState,
    readAgentWorkspaceFile,
    readJson,
    restartAgentFromControl,
    root: ROOT,
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
    agentAvailableForAutoWork,
    agentCapabilityQuestionIntent,
    agentMemoryWriteIntent,
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskFromThreadIntent,
    currentActor: (req) => cloudAuth.currentActor(req),
    deliverMessageToAgent,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState: () => state,
    inferAgentMemoryWriteback,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    scheduleAgentMemoryWriteback,
    searchAgentMemory,
    sendError,
    sendJson,
    stopTaskFromThread,
    taskCreationIntent,
    taskEndIntent,
    taskStopIntent,
    taskThreadDeliveryMessage,
    userPreferenceIntent,
  };
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

  if (await handleMessageApi(req, res, url, messageApiDeps())) return true;

  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
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
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'API route not found.');
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, error.message || 'Internal server error.');
  }
}

await ensureStorage();
await cloudAuth.initializeStorage();
await cloudAuth.ensureConfiguredAdmin();

const server = http.createServer(handleRequest);
server.on('upgrade', (req, socket) => {
  daemonRelay.handleUpgrade(req, socket).then((handled) => {
    if (!handled) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  }).catch((error) => {
    socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\n');
    socket.end(error.message || 'WebSocket upgrade failed.');
  });
});
const heartbeatTimer = setInterval(() => {
  if (reconcileAgentStatusHeartbeats()) {
    persistState().then(broadcastState).catch(() => {});
    return;
  }
  if (sseClients.size) broadcastHeartbeat();
}, STATE_HEARTBEAT_MS);
heartbeatTimer.unref?.();

server.listen(PORT, HOST, () => {
  addSystemEvent('server_started', `Magclaw local server started at http://${HOST}:${PORT}`);
  startReminderScheduler();
  fireDueReminders().catch((error) => {
    addSystemEvent('reminder_startup_fire_error', `Startup reminder check failed: ${error.message}`);
    persistState().then(broadcastState).catch(() => {});
  });
  persistState().then(broadcastState);
  console.log(`Magclaw local is running at http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearInterval(heartbeatTimer);
  stopReminderScheduler();
  for (const child of runningProcesses.values()) child.kill('SIGTERM');
  for (const proc of agentProcesses.values()) {
    if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
  }
  const forceExit = setTimeout(() => process.exit(0), 1500);
  forceExit.unref?.();
  server.close(async () => {
    try {
      await cloudAuth.close?.();
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
  server.closeAllConnections?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
