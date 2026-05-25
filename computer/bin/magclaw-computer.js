#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function seedComputerPackageInfo() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = String(packageJson.version || '').trim();
    if (!process.env.MAGCLAW_ENTRY_PACKAGE_NAME) process.env.MAGCLAW_ENTRY_PACKAGE_NAME = '@magclaw/computer';
    if (version && !process.env.MAGCLAW_ENTRY_PACKAGE_VERSION) process.env.MAGCLAW_ENTRY_PACKAGE_VERSION = version;
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_NAME) process.env.MAGCLAW_DAEMON_PACKAGE_NAME = '@magclaw/computer';
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_KIND) process.env.MAGCLAW_DAEMON_PACKAGE_KIND = 'computer';
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_BIN) process.env.MAGCLAW_DAEMON_PACKAGE_BIN = 'magclaw-computer';
    if (version && !process.env.MAGCLAW_DAEMON_PACKAGE_SPEC) process.env.MAGCLAW_DAEMON_PACKAGE_SPEC = `@magclaw/computer@${version}`;
  } catch {}
}

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

seedComputerPackageInfo();
const { formatDaemonLogLine, main } = await loadCliCore();
const args = process.argv.slice(2);
const normalizedArgs = process.env.MAGCLAW_COMPUTER_DAEMON === '1' || args[0] === 'computer' ? args : ['computer', ...args];

main([process.argv[0], process.argv[1], ...normalizedArgs]).catch((error) => {
  console.error(formatDaemonLogLine('error', 'computer', error?.message || String(error)));
  process.exit(1);
});
