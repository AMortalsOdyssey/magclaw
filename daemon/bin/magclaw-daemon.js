#!/usr/bin/env node
import { formatDaemonLogLine, main } from '../src/cli.js';

main(process.argv).catch((error) => {
  console.error(formatDaemonLogLine('error', 'daemon', error?.message || String(error)));
  process.exit(1);
});
