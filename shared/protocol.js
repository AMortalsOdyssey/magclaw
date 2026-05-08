export const DAEMON_CAPABILITIES = Object.freeze([
  'agent:start',
  'agent:deliver',
  'agent:stop',
  'agent:skills:list',
  'machine:runtime_models:detect',
]);

export const DAEMON_PROFILE_ROOT = '~/.magclaw/daemon/profiles/<serverSlug>/';

export const PAIRING_COMMAND_TEMPLATE = [
  'npx -y @magclaw/daemon@latest connect',
  '--server-url {serverUrl}',
  '--pair-token {pairToken}',
  '--profile {profile}',
  '--background',
  '# {serverName}',
].join(' ');

