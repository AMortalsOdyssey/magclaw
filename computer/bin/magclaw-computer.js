#!/usr/bin/env node

async function loadDaemonCli() {
  try {
    return await import('@magclaw/daemon/src/cli.js');
  } catch (error) {
    const localDaemonCli = new URL('../../daemon/src/cli.js', import.meta.url);
    try {
      return await import(localDaemonCli.href);
    } catch {
      throw error;
    }
  }
}

const { formatDaemonLogLine, main } = await loadDaemonCli();
const args = process.argv.slice(2);
const normalizedArgs = args[0] === 'computer' ? args : ['computer', ...args];

main([process.argv[0], process.argv[1], ...normalizedArgs]).catch((error) => {
  console.error(formatDaemonLogLine('error', 'computer', error?.message || String(error)));
  process.exit(1);
});
