import { readFileSync } from 'node:fs';
import path from 'node:path';

export const RELEASE_COMPONENTS = ['web', 'daemon'];

export const RELEASE_CATEGORY_KEYS = ['new', 'bugFix', 'approval', 'features', 'fixes', 'improved'];

export const RELEASE_CATEGORY_LABELS = {
  new: 'NEW',
  bugFix: 'BUG FIX',
  approval: 'APPROVAL',
  features: 'FEATURE',
  fixes: 'FIX',
  improved: 'IMPROVED',
};

const WEB_RELEASES = [
  {
    version: '0.3.6',
    date: '2026-05-22',
    title: 'Daemon CLI shim hardening',
    new: [],
    bugFix: [
      'Daemon CLI installation skips transient npx and npm script PATH directories.',
    ],
    approval: [],
  },
  {
    version: '0.3.5',
    date: '2026-05-22',
    title: 'Daemon CLI release',
    new: [
      'Release notes now track daemon CLI status, stop, and restore controls.',
    ],
    bugFix: [],
    approval: [],
  },
  {
    version: '0.3.4',
    date: '2026-05-22',
    title: 'Daemon upgrade visibility',
    new: [],
    bugFix: [
      'Daemon upgrade controls only appear when an update or upgrade state exists.',
    ],
    approval: [],
  },
  {
    version: '0.3.3',
    date: '2026-05-22',
    title: 'Daemon service verification',
    new: [],
    bugFix: [
      'Remote daemon upgrades no longer trust stale background service state.',
    ],
    approval: [],
  },
  {
    version: '0.3.2',
    date: '2026-05-22',
    title: 'Remote daemon upgrades',
    new: [
      'Owners and admins can trigger daemon upgrades from Computer details.',
      'Upgrade status shows waiting, progress, rollback, and failure states.',
    ],
    bugFix: [
      'Queued Agent work resumes after the upgraded daemon reconnects.',
    ],
    approval: [
      'Remote daemon upgrades still require owner or admin confirmation.',
    ],
  },
  {
    version: '0.3.1',
    date: '2026-05-22',
    title: 'Agent memory mirror',
    new: [
      'Agent memory mirrors only MEMORY.md to cloud storage while workspace files stay on the Computer.',
      'Offline Agent workspaces fall back to the cloud MEMORY.md mirror with source status.',
    ],
    bugFix: [
      'Local memory writes succeed even when PVC or PostgreSQL mirror sync fails.',
    ],
    approval: [],
  },
  {
    version: '0.3.0',
    date: '2026-05-21',
    title: 'SSE broadcasts and Feishu login',
    features: [
      'Feishu authorization login is now supported.',
    ],
    improved: [
      'SSE broadcasts are leaner and more reliable.',
    ],
    fixes: [],
  },
];

const DAEMON_RELEASES = [
  {
    version: '0.1.16',
    date: '2026-05-22',
    title: 'CLI install path hardening',
    new: [],
    bugFix: [
      'install-cli skips transient npx and npm script PATH directories.',
    ],
    approval: [],
  },
  {
    version: '0.1.15',
    date: '2026-05-22',
    title: 'Durable magclaw CLI',
    new: [
      'Connect installs a durable magclaw command for status, logs, stop, and restore.',
      'The install-cli command repairs the local magclaw shim without reconnecting.',
    ],
    bugFix: [
      'macOS, Linux, and Windows shims no longer depend on transient npx cache paths.',
    ],
    approval: [],
  },
  {
    version: '0.1.14',
    date: '2026-05-22',
    title: 'Agent workspace relay',
    new: [
      'Agent workspaces can read local daemon files and sync MEMORY.md mirrors.',
    ],
    bugFix: [],
    approval: [],
  },
  {
    version: '0.1.13',
    date: '2026-05-22',
    title: 'Active service upgrade guard',
    new: [],
    bugFix: [
      'Remote upgrades verify the profile system service is active before starting.',
    ],
    approval: [],
  },
  {
    version: '0.1.12',
    date: '2026-05-22',
    title: 'Default magclaw launcher',
    new: [
      'The daemon package exposes magclaw as the default npx command.',
    ],
    bugFix: [
      'Service launchers restart through the magclaw command after upgrades.',
    ],
    approval: [],
  },
  {
    version: '0.1.11',
    date: '2026-05-22',
    title: 'Background self-upgrade worker',
    new: [
      'Background daemon services can stage packages, restart, and report upgrade progress.',
    ],
    bugFix: [
      'Failed target starts roll back to the previous launcher version.',
    ],
    approval: [
      'Upgrade workers only run after a server-issued upgrade command.',
    ],
  },
  {
    version: '0.1.10',
    date: '2026-05-21',
    title: 'Runtime-native agent hook layout',
    features: [
      'Agent workspaces now prepare runtime-specific hook directories for Codex and Claude Code.',
    ],
    improved: [
      'Codex hooks and Claude Code settings are linked into the runtime-native locations expected by each CLI.',
    ],
    fixes: [],
  },
  {
    version: '0.1.9',
    date: '2026-05-21',
    title: 'Long-task permission runtime',
    features: [
      'Codex daemon runs now inherit Agent permission grants and use full development workspace access for ordinary engineering work.',
    ],
    improved: [
      'High-risk actions keep a chat confirmation boundary instead of surfacing raw Codex approval prompts.',
    ],
    fixes: [
      'Codex app-server starts with a writable sandbox policy so long-running delegated work no longer stalls on routine file and command access.',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-05-14',
    title: 'Workspace replies and remote skills',
    features: [
      'Cloud-connected daemon agents now expose linked global Codex skills plus agent-isolated skill install folders.',
    ],
    improved: [],
    fixes: [
      'Agent replies to #all threads now resolve the requested workspace before validating the target channel.',
      'Agent mention chips inside chat messages now open the Agent detail panel.',
    ],
  },
  {
    version: '0.1.5',
    date: '2026-05-14',
    title: 'Codex runtime trust config',
    features: [],
    improved: [],
    fixes: [
      'Cloud-connected npm daemon agents now generate trusted Codex homes so Codex app-server can load project-local config and run chat turns.',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-05-14',
    title: 'Production domain npm examples',
    features: [],
    improved: [
      'Daemon npm examples now use the production MagClaw domain.',
    ],
    fixes: [],
  },
  {
    version: '0.1.3',
    date: '2026-05-14',
    title: 'Daemon heartbeat and structured logs',
    features: [
      'Daemon sends a periodic heartbeat while connected so Computer status stays online through idle periods.',
    ],
    improved: [
      'Foreground daemon logs now include local timestamp, level, and category on every daemon-owned line.',
    ],
    fixes: [
      'Idle daemon connections are kept active instead of relying only on reconnect attempts.',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-05-09',
    title: 'Cloud daemon profile and runtime reporting',
    features: [
      'Daemon reports its package version, machine fingerprint, profile, and detected runtime details to MagClaw Cloud.',
      'Computer connect commands use a fixed machine API key so the same command can reconnect after the daemon stops.',
    ],
    improved: [
      'Runtime detection covers Claude Code, Codex CLI, Kimi CLI, Cursor CLI, Gemini CLI, Copilot CLI, and OpenCode.',
      'Codex path repair and model metadata make Agent creation match the selected Computer capabilities.',
    ],
    fixes: [
      'Unsupported runtime starts now fail with an error state instead of leaving Agents thinking forever.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-05-06',
    title: 'Initial daemon package boundary',
    features: [
      'The local daemon can be installed independently and connected to a cloud server profile.',
    ],
    improved: [],
    fixes: [],
  },
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function readPackageVersion(root, packagePath) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'));
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function normalizeReleaseItem(item, index = 0) {
  const version = normalizeVersion(item?.version);
  const date = normalizeDate(item?.date || item?.releasedAt);
  return {
    id: String(item?.id || `${version || 'release'}-${index}`),
    version,
    date,
    title: String(item?.title || ''),
    new: safeArray(item?.new).map(String).filter(Boolean),
    bugFix: safeArray(item?.bugFix).map(String).filter(Boolean),
    approval: safeArray(item?.approval).map(String).filter(Boolean),
    features: safeArray(item?.features).map(String).filter(Boolean),
    fixes: safeArray(item?.fixes).map(String).filter(Boolean),
    improved: safeArray(item?.improved).map(String).filter(Boolean),
  };
}

function compareVersionsDescending(a, b) {
  const aParts = String(a || '').split('.').map((part) => Number.parseInt(part, 10));
  const bParts = String(b || '').split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = Number.isFinite(aParts[index]) ? aParts[index] : 0;
    const bPart = Number.isFinite(bParts[index]) ? bParts[index] : 0;
    if (aPart !== bPart) return bPart - aPart;
  }
  return String(b || '').localeCompare(String(a || ''));
}

function normalizeReleaseItems(items) {
  return safeArray(items)
    .map(normalizeReleaseItem)
    .filter((item) => item.version && item.date)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || compareVersionsDescending(a.version, b.version));
}

function mergeReleaseItems(existingItems, defaultItems) {
  const defaults = normalizeReleaseItems(defaultItems);
  return defaults.length ? defaults : normalizeReleaseItems(existingItems);
}

function firstReleaseVersion(releases) {
  return normalizeReleaseItems(releases)[0]?.version || '';
}

function normalizeComponent(component, defaults = {}) {
  const releases = mergeReleaseItems(component?.releases, defaults.releases);
  return {
    component: String(component?.component || defaults.component || ''),
    packageName: String(component?.packageName || defaults.packageName || ''),
    currentVersion: normalizeVersion(defaults.currentVersion || component?.currentVersion || firstReleaseVersion(releases)),
    latestVersion: normalizeVersion(defaults.latestVersion || component?.latestVersion || firstReleaseVersion(releases)),
    releases,
  };
}

export function defaultReleaseNotes({ root = process.cwd(), env = process.env } = {}) {
  const webVersion = normalizeVersion(env.MAGCLAW_WEB_VERSION || readPackageVersion(root, 'web') || WEB_RELEASES[0].version);
  const daemonVersion = normalizeVersion(env.MAGCLAW_DAEMON_VERSION || readPackageVersion(root, 'daemon') || DAEMON_RELEASES[0].version);
  return {
    web: normalizeComponent({
      component: 'web',
      packageName: '@magclaw/web',
      currentVersion: webVersion,
      latestVersion: normalizeVersion(env.MAGCLAW_WEB_LATEST_VERSION || webVersion || WEB_RELEASES[0].version),
      releases: WEB_RELEASES,
    }),
    daemon: normalizeComponent({
      component: 'daemon',
      packageName: '@magclaw/daemon',
      currentVersion: daemonVersion,
      latestVersion: normalizeVersion(env.MAGCLAW_DAEMON_LATEST_VERSION || daemonVersion || DAEMON_RELEASES[0].version),
      releases: DAEMON_RELEASES,
    }),
  };
}

export function normalizeReleaseNotes(value = {}, defaults = {}) {
  const defaultNotes = defaults.web && defaults.daemon ? defaults : defaultReleaseNotes();
  return {
    web: normalizeComponent(value?.web, defaultNotes.web),
    daemon: normalizeComponent(value?.daemon, defaultNotes.daemon),
  };
}
