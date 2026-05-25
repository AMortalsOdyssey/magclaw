const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const MAGCLAW = '\u001b[38;2;255;102;204m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const CYAN = '\u001b[36m';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '');
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0) || 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function visibleLength(value) {
  return Array.from(stripAnsi(value)).reduce((width, character) => width + characterWidth(character), 0);
}

function colorize(enabled, code, value) {
  return enabled ? `${code}${value}${RESET}` : value;
}

function padVisible(value, width) {
  const text = String(value ?? '');
  return `${text}${' '.repeat(Math.max(0, width - visibleLength(text)))}`;
}

function fallback(value, empty = '-') {
  const text = String(value || '').trim();
  return text || empty;
}

function statusLabel(profile, color) {
  if (profile.running) return colorize(color, GREEN, 'RUNNING');
  if (profile.service?.active) return colorize(color, YELLOW, 'SERVICE');
  return colorize(color, RED, 'STOPPED');
}

function serviceLabel(profile) {
  const mode = fallback(profile.service?.mode, 'foreground');
  return profile.service?.active ? `${mode}: active` : `${mode}: inactive`;
}

export function shouldUseColor({ env = process.env, stream = process.stdout, flags = {} } = {}) {
  if (flags.color === true || flags.color === 'true' || flags.color === 'always') return true;
  if (flags.noColor || flags.color === 'false' || flags.color === 'never' || env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return Boolean(stream?.isTTY);
}

export function formatBeijingTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '-';
  const date = new Date(timestamp + BEIJING_OFFSET_MS);
  const pad = (item) => String(item).padStart(2, '0');
  return [
    `${date.getUTCFullYear()}年${pad(date.getUTCMonth() + 1)}月${pad(date.getUTCDate())}日`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(' ');
}

function rowForProfile(profile, color) {
  return {
    status: statusLabel(profile, color),
    profile: fallback(profile.profile),
    computerName: fallback(profile.computerName || profile.name),
    serverName: fallback(profile.serverName || profile.serverSlug || profile.workspaceId),
    serverSlug: fallback(profile.serverSlug || profile.profile),
    computerId: fallback(profile.computerId),
    service: serviceLabel(profile),
    updatedAt: formatBeijingTimestamp(profile.updatedAt || profile.createdAt),
  };
}

function renderTable(rows, color) {
  const headers = {
    status: 'Status',
    profile: 'Profile',
    computerName: 'Computer Name',
    serverName: 'Server Name',
    serverSlug: 'Server Slug',
    computerId: 'Computer ID',
    service: 'Service',
    updatedAt: 'Updated At (UTC+8)',
  };
  const keys = Object.keys(headers);
  const widths = Object.fromEntries(keys.map((key) => [
    key,
    Math.max(visibleLength(headers[key]), ...rows.map((row) => visibleLength(row[key]))),
  ]));
  const divider = `+-${keys.map((key) => '-'.repeat(widths[key])).join('-+-')}-+`;
  const renderRow = (row) => `| ${keys.map((key) => padVisible(row[key], widths[key])).join(' | ')} |`;
  return [
    divider,
    renderRow(Object.fromEntries(keys.map((key) => [key, colorize(color, BOLD, headers[key])]))),
    divider,
    ...rows.map(renderRow),
    divider,
  ].join('\n');
}

export function renderListProfiles(payload = {}, options = {}) {
  const color = Boolean(options.color);
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const runningCount = profiles.filter((profile) => profile.running).length;
  const machineTokenCount = profiles.filter((profile) => profile.hasMachineToken).length;
  const pairTokenCount = profiles.filter((profile) => profile.hasPairToken).length;
  const title = colorize(color, `${BOLD}${MAGCLAW}`, 'MagClaw Computers');
  const summary = [
    `${colorize(color, MAGCLAW, 'Profiles')}: ${profiles.length}`,
    `${colorize(color, GREEN, 'Running')}: ${runningCount}`,
    `${colorize(color, CYAN, 'Machine Tokens')}: ${machineTokenCount}`,
    `${colorize(color, YELLOW, 'Pair Tokens')}: ${pairTokenCount}`,
  ].join('  ');
  const lines = [
    title,
    summary,
    `${colorize(color, DIM, 'Root')}: ${payload.root || '-'}`,
    '',
  ];
  if (!profiles.length) {
    lines.push('No saved Computers found.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(renderTable(profiles.map((profile) => rowForProfile(profile, color)), color));
  return `${lines.join('\n')}\n`;
}
