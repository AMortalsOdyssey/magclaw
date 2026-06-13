import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTeamSharingOnboardingFeedback,
  renderTeamSharingFeedbackMarkdown,
  renderTeamSharingFeedbackText,
} from './onboarding-feedback.js';
import {
  deleteTeamSharingLink,
  disableTeamSharingSkill,
  editTeamSharingLink,
  initTeamSharingProject,
  installTeamSharingHooks,
  installTeamSharingSkill,
  listTeamSharingLinks,
  listTeamSharingProjects,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  maybeAutoUpdateTeamSharingPackage,
  readTeamSharingContext,
  readTeamSharingLink,
  removeTeamSharingHooks,
  removeTeamSharingSkill,
  searchTeamSharing,
  setTeamSharingProjectEnabled,
  shareTeamSharingArtifact,
  setupTeamSharing,
  statusTeamSharingHooks,
  statusTeamSharingProject,
  statusTeamSharingSkill,
  syncTeamSharingTranscript,
  updateTeamSharingPackage,
  getTeamSharingSessionReporting,
  setTeamSharingSessionReporting,
  unsetTeamSharingProject,
  formatTeamSharingReadLinkResult,
  whoamiTeamSharingProfile,
} from './team-sharing.js';

const DEFAULT_PROFILE = 'default';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
})();
export const TEAM_SHARING_VERSION = String(PACKAGE_JSON.version || '0.0.0');

function safeProfileName(value = DEFAULT_PROFILE) {
  return String(value || DEFAULT_PROFILE).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_PROFILE;
}

function parseFlagKey(item) {
  return item
    .replace(/^--/, '')
    .replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

export function parseCli(argv = process.argv, env = process.env) {
  const args = argv.slice(2);
  if (args[0] === 'team-sharing') args.shift();
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '-h') {
      flags.help = true;
      continue;
    }
    if (item === '-V') {
      flags.version = true;
      continue;
    }
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const equalsIndex = item.indexOf('=');
    if (equalsIndex > 2) {
      flags[parseFlagKey(item.slice(0, equalsIndex))] = item.slice(equalsIndex + 1);
      continue;
    }
    const key = parseFlagKey(item);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  flags._ = positionals;
  if (flags.json) flags.format = 'json';
  flags.profileExplicit = Boolean(flags.profile);
  flags.profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  return { command: 'team-sharing', flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function outputFormat(flags = {}, stdout = process.stdout, options = {}) {
  const format = String(flags.format || 'auto').trim().toLowerCase();
  if (['json', 'text', 'markdown'].includes(format)) return format;
  if (flags.json) return 'json';
  const defaultFormat = String(options.defaultFormat || '').trim().toLowerCase();
  if (['json', 'text', 'markdown'].includes(defaultFormat)) return defaultFormat;
  return stdout?.isTTY ? 'text' : 'json';
}

function printResult(value, flags = {}, env = process.env, options = {}) {
  const format = outputFormat(flags, process.stdout, options);
  if (format === 'json' || !value?.feedback) {
    printJson(value);
    return;
  }
  if (format === 'markdown') {
    process.stdout.write(`${renderTeamSharingFeedbackMarkdown(value.feedback)}\n`);
    return;
  }
  const color = env.NO_COLOR ? false : Boolean(process.stdout?.isTTY || env.FORCE_COLOR);
  process.stdout.write(`${renderTeamSharingFeedbackText(value.feedback, { color })}\n`);
}

function stringFlagValue(value) {
  if (value === undefined || value === null || value === true || value === false) return '';
  return String(value).trim();
}

function hasSyncTranscriptPath(flags = {}) {
  return Boolean(
    stringFlagValue(flags.transcript)
      || stringFlagValue(flags.file)
      || stringFlagValue(flags.transcriptPath)
      || stringFlagValue(flags._?.[1]),
  );
}

async function readHookPayloadStdin(stdin = process.stdin) {
  if (!stdin || stdin.isTTY) return '';
  let text = '';
  for await (const chunk of stdin) text += chunk;
  return text.trim();
}

function renderTeamSharingHelp() {
  return [
    'Usage: team-sharing <command> [options]',
    '       magclaw team-sharing <command> [options]',
    '',
    'Commands:',
    '  setup    Configure login, project channel, hooks, and skill',
    '  login    Browser/device login for scoped team-sharing sync token',
    '  logout   Revoke and remove the cached Team Sharing token',
    '  relogin  Force a fresh browser/device login',
    '  whoami   Show the current Team Sharing identity',
    '  projects List configured project paths',
    '  init     Write .magclaw/team-sharing.yaml for this project',
    '  unset    Remove this project Team Sharing config',
    '  enable   Enable this project sync',
    '  disable  Disable this project sync',
    '  status   Show project/login/hook/skill status',
    '  doctor   Check local config, server auth, hooks, skill, and upgrade state',
    '  upgrade  Compatibility alias for update --check --force',
    '  update   Check, stage, activate, and sync Team Sharing package updates',
    '  search   Query shared team sharing (--time yesterday, --keyword A, --topics A,B, --mode hybrid|keyword|semantic, --scope hybrid|channel|server)',
    '  context  Read original context around an anchor',
    '  read-link Read a protected MagClaw share/context URL with the Team Sharing CLI login',
    '  edit-link Patch one section of an existing MagClaw share URL',
    '  list-links List MagClaw share links for the current server',
    '  delete-link Delete one MagClaw share link by URL or share ID',
    '  share-artifact Create a public MagClaw share link from a local file',
    '  sync     Upload one transcript file (--session-title or MAGCLAW_SESSION_TITLE controls the displayed title)',
    '  session-reporting Control reporting for one local session (off|on|status)',
    '  skills   Install/remove/status the local Team Sharing skill',
    '  hooks    Install/remove/status Team Sharing hooks',
    '',
    'Example:',
    '  npx @magclaw/team-sharing@latest setup --server-url https://magclaw.multiego.me --channel <channel-path>',
    '',
  ].join('\n');
}

async function runFeatureInstallCommand(kind, flags = {}, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  if (subcommand === 'help' || flags.help) {
    process.stdout.write(`Usage: team-sharing ${kind} <install|remove|enable|disable|status>\n`);
    return;
  }
  if (kind === 'skills') {
    if (subcommand === 'install' || subcommand === 'enable') printResult(await installTeamSharingSkill(flags, env), flags, env);
    else if (subcommand === 'remove') printJson(await removeTeamSharingSkill(flags, env));
    else if (subcommand === 'disable') printJson(await disableTeamSharingSkill(flags, env));
    else if (subcommand === 'status') printResult(await statusTeamSharingSkill(flags, env), flags, env);
    else throw new Error(`Unknown skills command: ${subcommand}`);
    return;
  }
  if (subcommand === 'install' || subcommand === 'enable') printResult(await installTeamSharingHooks(flags, env), flags, env);
  else if (subcommand === 'remove' || subcommand === 'disable') printJson(await removeTeamSharingHooks(flags, env));
  else if (subcommand === 'status') printResult(await statusTeamSharingHooks(flags, env), flags, env);
  else throw new Error(`Unknown hooks command: ${subcommand}`);
}

export async function runTeamSharingCommand(flags = {}, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  if (subcommand === 'help' || flags.help) {
    process.stdout.write(renderTeamSharingHelp());
    return;
  }
  const nestedFlags = { ...flags, _: flags._?.slice(1) || [] };
  switch (subcommand) {
    case 'setup':
    case 'install':
      {
        const result = await setupTeamSharing(flags, env);
        result.packageUpdate = await maybeAutoUpdateTeamSharingPackage({
          ...flags,
          trigger: 'setup',
          all: true,
          target: flags.target || 'all',
        }, env);
        printResult(result, flags, env, { defaultFormat: 'text' });
      }
      break;
    case 'login':
      printJson(await loginTeamSharingProfile(flags, env));
      break;
    case 'relogin':
      await logoutTeamSharingProfile(flags, env);
      printJson(await loginTeamSharingProfile(flags, env));
      break;
    case 'logout':
      printJson(await logoutTeamSharingProfile(flags, env));
      break;
    case 'whoami':
      printJson(await whoamiTeamSharingProfile(flags, env));
      break;
    case 'projects':
      printJson(await listTeamSharingProjects({ ...flags, status: flags._?.[1] === 'status' || flags.status }, env));
      break;
    case 'init':
      printJson(await initTeamSharingProject(flags, env));
      break;
    case 'unset':
      printJson(await unsetTeamSharingProject(flags, env));
      break;
    case 'enable':
      printJson(await setTeamSharingProjectEnabled(flags, env, true));
      break;
    case 'disable':
      printJson(await setTeamSharingProjectEnabled(flags, env, false));
      break;
    case 'status':
      {
        const project = await statusTeamSharingProject(flags, env);
        const hooks = await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env);
        const skill = await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env);
        const packageUpdate = await maybeAutoUpdateTeamSharingPackage({
          ...flags,
          trigger: 'status',
          all: true,
          target: flags.target || 'all',
        }, env);
        const ok = Boolean(project.ok && hooks.ok && skill.ok);
        printResult({
          ok,
          project,
          hooks,
          skill,
          packageUpdate,
          feedback: buildTeamSharingOnboardingFeedback({
            operation: 'status',
            ok,
            project,
            hooks,
            skill,
          }),
        }, flags, env);
      }
      break;
    case 'doctor':
      {
        const project = await statusTeamSharingProject(flags, env);
        const hooks = await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env);
        const skill = await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env);
        const packageUpdate = await maybeAutoUpdateTeamSharingPackage({
          ...flags,
          trigger: 'doctor',
          all: true,
          target: flags.target || 'all',
        }, env);
        const ok = Boolean(project.ok && hooks.ok && skill.ok && packageUpdate.ok !== false);
        printResult({
          ok,
          project,
          hooks,
          skill,
          upgrade: packageUpdate,
          packageUpdate,
          feedback: buildTeamSharingOnboardingFeedback({
            operation: 'doctor',
            ok,
            project,
            hooks,
            skill,
          }),
        }, flags, env);
      }
      break;
    case 'upgrade':
      printJson(await updateTeamSharingPackage({ ...flags, check: true, force: true, manual: true }, env));
      break;
    case 'update':
      printJson(await updateTeamSharingPackage({
        ...flags,
        check: Boolean(flags.check || flags._?.[1] === 'check'),
        manual: true,
      }, env));
      break;
    case 'search':
      printJson(await searchTeamSharing(flags, env));
      break;
    case 'context':
      printJson(await readTeamSharingContext(flags, env));
      break;
    case 'read-link':
    case 'readlink':
      {
        const result = await readTeamSharingLink(flags, env);
        const format = String(flags.format || 'json').trim().toLowerCase();
        if (!format || format === 'json') printJson(result);
        else process.stdout.write(`${formatTeamSharingReadLinkResult(result, format)}\n`);
      }
      break;
    case 'edit-link':
    case 'editlink':
      printJson(await editTeamSharingLink(flags, env));
      break;
    case 'list-links':
    case 'listlinks':
    case 'list-shares':
    case 'listshares':
      printJson(await listTeamSharingLinks(flags, env));
      break;
    case 'delete-link':
    case 'deletelink':
    case 'delete-share':
    case 'deleteshare':
    case 'remove-link':
    case 'removelink':
      printJson(await deleteTeamSharingLink(flags, env));
      break;
    case 'share':
    case 'share-artifact':
    case 'quickshare':
      printJson(await shareTeamSharingArtifact(flags, env));
      break;
    case 'sync':
      {
        const syncFlags = { ...flags, integration: flags.integration || 'team-sharing' };
        if ((syncFlags.hookEvent || syncFlags.hookEventName) && !hasSyncTranscriptPath(syncFlags) && !syncFlags.hookPayload) {
          const hookPayload = await readHookPayloadStdin();
          if (hookPayload) syncFlags.hookPayload = hookPayload;
        }
        const result = await syncTeamSharingTranscript(syncFlags, env);
        if (syncFlags.hookEvent || syncFlags.hookEventName || syncFlags.hookPayload) {
          result.packageUpdate = await maybeAutoUpdateTeamSharingPackage({
            ...flags,
            trigger: 'hook',
            all: true,
            target: flags.target || 'all',
          }, env);
        }
        printJson(result);
      }
      break;
    case 'session-reporting':
    case 'session-report':
    case 'reporting':
      {
        const action = String(flags._?.[1] || flags.action || 'status').trim().toLowerCase();
        if (['off', 'disable', 'disabled', 'no-report', 'skip', 'mute'].includes(action)) {
          printJson(await setTeamSharingSessionReporting({ ...flags, report: false }, env));
        } else if (['on', 'enable', 'enabled', 'report', 'unmute'].includes(action)) {
          printJson(await setTeamSharingSessionReporting({ ...flags, report: true }, env));
        } else if (['status', 'show', 'get'].includes(action)) {
          printJson(await getTeamSharingSessionReporting(flags, env));
        } else {
          throw new Error('Usage: team-sharing session-reporting <off|on|status> --session-id <id> or --transcript <path>');
        }
      }
      break;
    case 'skills':
    case 'skill':
      await runFeatureInstallCommand('skills', nestedFlags, env);
      break;
    case 'hooks':
    case 'hook':
      await runFeatureInstallCommand('hooks', nestedFlags, env);
      break;
    default:
      throw new Error(`Unknown team-sharing command: ${subcommand}`);
  }
}

export async function main(argv = process.argv, env = process.env) {
  const { flags } = parseCli(argv, env);
  if (flags.version) {
    process.stdout.write(`${TEAM_SHARING_VERSION}\n`);
    return;
  }
  await runTeamSharingCommand(flags, {
    ...env,
    MAGCLAW_ENTRY_PACKAGE_NAME: '@magclaw/team-sharing',
    MAGCLAW_TEAM_SHARING_VERSION: env.MAGCLAW_TEAM_SHARING_VERSION || TEAM_SHARING_VERSION,
  });
}
