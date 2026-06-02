#!/usr/bin/env node
import { main } from '@magclaw/cli-core/src/cli.js';

const TEAM_SHARING_VERSION = '0.1.40';

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write(`${TEAM_SHARING_VERSION}\n`);
  process.exit(0);
}

main([process.argv[0], process.argv[1], 'team-sharing', ...process.argv.slice(2)], {
  ...process.env,
  MAGCLAW_ENTRY_PACKAGE_NAME: '@magclaw/team-sharing',
  MAGCLAW_TEAM_SHARING_VERSION: process.env.MAGCLAW_TEAM_SHARING_VERSION || TEAM_SHARING_VERSION,
}).catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
