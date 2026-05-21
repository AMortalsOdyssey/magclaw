import { readFileSync } from 'node:fs';
import path from 'node:path';

export const RELEASE_COMPONENTS = ['web', 'daemon'];

export const RELEASE_CATEGORY_LABELS = {
  features: 'FEATURE',
  fixes: 'FIX',
  improved: 'IMPROVED',
};

const WEB_RELEASES = [
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
    features: safeArray(item?.features).map(String).filter(Boolean),
    fixes: safeArray(item?.fixes).map(String).filter(Boolean),
    improved: safeArray(item?.improved).map(String).filter(Boolean),
  };
}

function normalizeReleaseItems(items) {
  return safeArray(items)
    .map(normalizeReleaseItem)
    .filter((item) => item.version && item.date)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.version.localeCompare(a.version));
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
