#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function seedDaemonPackageInfo() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = String(packageJson.version || '').trim();
    if (!process.env.MAGCLAW_ENTRY_PACKAGE_NAME) process.env.MAGCLAW_ENTRY_PACKAGE_NAME = '@magclaw/daemon';
    if (version && !process.env.MAGCLAW_ENTRY_PACKAGE_VERSION) process.env.MAGCLAW_ENTRY_PACKAGE_VERSION = version;
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_NAME) process.env.MAGCLAW_DAEMON_PACKAGE_NAME = '@magclaw/daemon';
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_KIND) process.env.MAGCLAW_DAEMON_PACKAGE_KIND = 'daemon';
    if (!process.env.MAGCLAW_DAEMON_PACKAGE_BIN) process.env.MAGCLAW_DAEMON_PACKAGE_BIN = 'magclaw';
    if (version && !process.env.MAGCLAW_DAEMON_PACKAGE_SPEC) process.env.MAGCLAW_DAEMON_PACKAGE_SPEC = `@magclaw/daemon@${version}`;
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

seedDaemonPackageInfo();
const { formatDaemonLogLine, main } = await loadCliCore();

main(process.argv).catch((error) => {
  console.error(formatDaemonLogLine('error', 'daemon', error?.message || String(error)));
  process.exit(1);
});
