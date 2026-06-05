import { spawnSync } from 'node:child_process';

export async function runExternalTeamSharingCommand(args = [], env = process.env) {
  const command = String(env.MAGCLAW_TEAM_SHARING_BIN || 'team-sharing').trim() || 'team-sharing';
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Team Sharing is packaged separately. Run `npx @magclaw/team-sharing@latest setup --server-url <magclaw-server-url> --channel <channel-path>` or install it globally with `npm i -g @magclaw/team-sharing`.');
    }
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exitCode = result.status;
  }
}
