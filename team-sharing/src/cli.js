import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTeamSharingUpgrade,
  disableTeamSharingSkill,
  initTeamSharingProject,
  installTeamSharingHooks,
  installTeamSharingSkill,
  listTeamSharingProjects,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  readTeamSharingContext,
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
  unsetTeamSharingProject,
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
  flags.profileExplicit = Boolean(flags.profile);
  flags.profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  return { command: 'team-sharing', flags };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
    '  upgrade  Check npm latest version for team-sharing',
    '  search   Query shared team sharing (--time yesterday, --keyword A, --topics A,B, --mode hybrid|keyword|semantic)',
    '  context  Read original context around an anchor',
    '  share-artifact Create a public MagClaw share link from a local file',
    '  sync     Upload one transcript file (--session-title or MAGCLAW_SESSION_TITLE controls the displayed title)',
    '  skills   Install/remove/status the local Team Sharing skill',
    '  hooks    Install/remove/status Team Sharing hooks',
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
    if (subcommand === 'install' || subcommand === 'enable') printJson(await installTeamSharingSkill(flags, env));
    else if (subcommand === 'remove') printJson(await removeTeamSharingSkill(flags, env));
    else if (subcommand === 'disable') printJson(await disableTeamSharingSkill(flags, env));
    else if (subcommand === 'status') printJson(await statusTeamSharingSkill(flags, env));
    else throw new Error(`Unknown skills command: ${subcommand}`);
    return;
  }
  if (subcommand === 'install' || subcommand === 'enable') printJson(await installTeamSharingHooks(flags, env));
  else if (subcommand === 'remove' || subcommand === 'disable') printJson(await removeTeamSharingHooks(flags, env));
  else if (subcommand === 'status') printJson(await statusTeamSharingHooks(flags, env));
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
      printJson(await setupTeamSharing(flags, env));
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
      printJson(await listTeamSharingProjects(flags, env));
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
      printJson({
        ok: true,
        project: await statusTeamSharingProject(flags, env),
        hooks: await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env),
        skill: await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env),
      });
      break;
    case 'doctor':
      printJson({
        ok: true,
        project: await statusTeamSharingProject(flags, env),
        hooks: await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env),
        skill: await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env),
        upgrade: await checkTeamSharingUpgrade({ force: Boolean(flags.force) }, env).catch((error) => ({ ok: false, error: error.message })),
      });
      break;
    case 'upgrade':
      printJson(await checkTeamSharingUpgrade({ force: true }, env));
      break;
    case 'search':
      printJson(await searchTeamSharing(flags, env));
      break;
    case 'context':
      printJson(await readTeamSharingContext(flags, env));
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
        printJson(await syncTeamSharingTranscript(syncFlags, env));
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
