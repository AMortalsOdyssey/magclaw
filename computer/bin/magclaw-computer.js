#!/usr/bin/env node

async function loadCliCore() {
  try {
    return await import('@magclaw/cli-core/src/cli.js');
  } catch (error) {
    const localCliCore = new URL('../../cli-core/src/cli.js', import.meta.url);
    try {
      return await import(localCliCore.href);
    } catch {
      throw error;
    }
  }
}

const { formatDaemonLogLine, main } = await loadCliCore();
const args = process.argv.slice(2);
const normalizedArgs = args[0] === 'computer' ? args : ['computer', ...args];

main([process.argv[0], process.argv[1], ...normalizedArgs]).catch((error) => {
  console.error(formatDaemonLogLine('error', 'computer', error?.message || String(error)));
  process.exit(1);
});
