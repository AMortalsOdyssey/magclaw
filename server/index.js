import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
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
  agentResponseIntent,
  autoTaskMessageIntent,
  availabilityBroadcastIntent,
  availabilityFollowupIntent,
  channelGreetingIntent,
  contextualAgentFollowupIntent,
  directAvailabilityIntent,
  inferTaskIntentKind,
  taskCreationIntent,
  taskEndIntent,
  taskStopIntent,
  userPreferenceIntent,
} from './intents.js';
import {
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
import { createCloudSync } from './cloud-sync.js';
import { createRoutingEngine } from './routing-engine.js';
import { createMissionRunner } from './mission-runner.js';
import { createSystemServices } from './system-services.js';
import { createStateCore } from './state-core.js';
import { createTaskOrchestrator } from './task-orchestrator.js';
import { createServerIo } from './server-io.js';
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
const DATA_DIR = path.join(ROOT, '.magclaw');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
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
const STATE_HEARTBEAT_MS = Math.max(25, Number(process.env.MAGCLAW_STATE_HEARTBEAT_MS || 1000));
const AGENT_STATUS_STALE_MS = Math.max(1000, Number(process.env.MAGCLAW_AGENT_STATUS_STALE_MS || 45_000));
const ROUTE_EVENTS_LIMIT = Math.max(50, Number(process.env.MAGCLAW_ROUTE_EVENTS_LIMIT || 500));
const AGENT_CARD_TEXT_LIMIT = 5000;
const FANOUT_API_TIMEOUT_MS = Math.max(500, Number(process.env.MAGCLAW_FANOUT_TIMEOUT_MS || 2500));
const CODEX_STREAM_RETRY_LIMIT = codexStreamRetryLimit();
const LEGACY_BRAIN_AGENT_ID = 'agt_magclaw_brain';
const BRAIN_AGENT_NAME = 'MagClaw Brain';
const BRAIN_AGENT_DESCRIPTION = 'Routes channel fan-out, task claim recommendations, agent cards, and memory writeback triggers.';
const CLOUD_PROTOCOL_VERSION = 1;
const CODEX_HOME_CONFIG_VERSION = 2;
const CODEX_FALLBACK_MODEL = 'gpt-5.5';
const SQLITE_BACKED_STATE_KEYS = ['messages', 'replies', 'tasks', 'workItems', 'events'];
const AGENT_BOOT_RESET_STATUSES = new Set(['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'error']);
const CODEX_HOME_SHARED_ENTRIES = [
  'auth.json',
];
const CODEX_HOME_STALE_SHARED_ENTRIES = [
  'config.toml',
  'AGENTS.md',
  'agent-rules',
  'plugins',
  'skills',
  'rules',
  'hooks.json',
  'hooks',
  'vendor_imports',
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
  BRAIN_AGENT_DESCRIPTION,
  BRAIN_AGENT_NAME,
  CLOUD_PROTOCOL_VERSION,
  CODEX_FALLBACK_MODEL,
  CODEX_HOME_CONFIG_VERSION,
  FANOUT_API_TIMEOUT_MS,
  LEGACY_BRAIN_AGENT_ID,
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
  isBrainAgent,
  isLegacyBrainRuntime,
  migrateState,
  normalizeBrainAgentConfig,
  normalizeCodexModelName,
  normalizeFanoutApiConfig,
  persistState,
  presenceHeartbeat,
  reconcileAgentStatusHeartbeats,
  reconcileBrainAgentConfigs,
  resolveCodexRuntime,
  setAgentStatus,
  stateJsonSnapshot,
} = stateCore;

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
  turnMetaAllWorkCancelled,
  turnMetaHasCancelledWork,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  visibleMentionLabel,
  workItemIsCancelled,
  workItemMatchesScope,
  workItemMatchesTask,
} = conversationModel;

const agentWorkspace = createAgentWorkspaceManager({
  addSystemEvent,
  channelAgentIds: (...args) => channelAgentIds(...args),
  getState: () => state,
  isBrainAgent,
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
  listAgentWorkspace,
  prepareAgentCodexHome,
  readAgentWorkspaceFile,
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
  isBrainAgent,
  makeId,
  now,
  renderMentionsForAgent,
  spaceDisplayName,
  taskIsClosed,
  taskLabel,
  visibleMentionLabel,
  AGENT_CARD_TEXT_LIMIT,
  BRAIN_AGENT_DESCRIPTION,
  BRAIN_AGENT_NAME,
  FANOUT_API_TIMEOUT_MS,
  LEGACY_BRAIN_AGENT_ID,
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
  isBrainAgent,
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
} = collabMemory;

const taskOrchestrator = createTaskOrchestrator({
  addCollabEvent,
  addTaskHistory,
  addTaskTimelineMessage,
  cancelWorkItemsForTask: (...args) => cancelWorkItemsForTask(...args),
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
  turnMetaAllWorkCancelled,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  writeAgentSessionFile,
  workItemMatchesScope,
  workItemMatchesTask,
  AGENT_BUSY_DELIVERY_DELAY_MS,
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
  cancelWorkItemsForScope,
  cancelWorkItemsForTask,
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

function collabApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    findAgent,
    findChannel,
    findComputer,
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
    createTaskFromMessage,
    createTaskMessage,
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
    markWorkItemResponded,
    normalizeIds,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    searchAgentMessageHistory,
    sendError,
    sendJson,
    taskLabel,
    updateTaskForAgent,
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
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskFromThreadIntent,
    deliverMessageToAgent,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState: () => state,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    scheduleAgentMemoryWriteback,
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
  if (!requireCloudDeploymentApi(req, res, url)) return true;

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

const server = http.createServer(handleRequest);
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
  persistState().then(broadcastState);
  console.log(`Magclaw local is running at http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => {
  clearInterval(heartbeatTimer);
  for (const child of runningProcesses.values()) child.kill('SIGTERM');
  for (const proc of agentProcesses.values()) {
    if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
  }
  server.close(() => process.exit(0));
});
