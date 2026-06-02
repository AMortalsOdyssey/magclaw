const DEFAULT_PROFILE = 'default';

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
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'connect';
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
  flags.profile = safeProfileName(flags.profile || env.MAGCLAW_DAEMON_PROFILE || DEFAULT_PROFILE);
  return { command, flags };
}
