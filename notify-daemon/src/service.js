import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notifyExecutableSearchPath } from './executable.js';

function xml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function systemdEscape(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function windowsQuote(value = '') {
  const raw = String(value);
  return `"${raw.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function notifyDaemonServiceSpec(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const instance = options.instance || 'default';
  const nodePath = options.nodePath || process.execPath;
  const binPath = options.binPath;
  const logPath = options.logPath;
  const errorLogPath = options.errorLogPath;
  const servicePath = notifyExecutableSearchPath({
    platform,
    homeDir,
    nodePath,
    pathEnv: options.pathEnv,
    env: options.env || process.env,
  });
  const args = [
    binPath, 'daemon', 'run', '--instance', instance,
    ...(options.notifyHome ? ['--notify-home', options.notifyHome] : []),
  ];
  const serviceName = `magclaw-notify-${instance}`;
  if (platform === 'darwin') {
    const label = `io.magclaw.notify.${instance}`;
    const file = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    const argumentsXml = [nodePath, ...args].map((item) => `      <string>${xml(item)}</string>`).join('\n');
    return {
      platform,
      serviceName,
      label,
      file,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argumentsXml}\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(servicePath)}</string>\n  </dict>\n  <key>StandardOutPath</key>\n  <string>${xml(logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(errorLogPath)}</string>\n</dict>\n</plist>\n`,
      enable: ['launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file]],
      start: ['launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${label}`]],
      stop: ['launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, file]],
      disable: ['launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, file]],
    };
  }
  if (platform === 'win32') {
    const taskName = `MagClaw Notify ${instance}`;
    const command = [nodePath, ...args].map(windowsQuote).join(' ');
    return {
      platform,
      serviceName,
      taskName,
      file: '',
      content: '',
      enable: ['schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', command]],
      start: ['schtasks.exe', ['/Run', '/TN', taskName]],
      stop: ['schtasks.exe', ['/End', '/TN', taskName]],
      disable: ['schtasks.exe', ['/Delete', '/F', '/TN', taskName]],
    };
  }
  const file = path.join(options.xdgConfigHome || process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'systemd', 'user', `${serviceName}.service`);
  return {
    platform,
    serviceName,
    file,
    content: `[Unit]\nDescription=MagClaw Notify daemon (${systemdEscape(instance)})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment="PATH=${systemdEscape(servicePath)}"\nExecStart=${[nodePath, ...args].map((item) => `"${systemdEscape(item)}"`).join(' ')}\nRestart=always\nRestartSec=3\nStandardOutput=append:${systemdEscape(logPath)}\nStandardError=append:${systemdEscape(errorLogPath)}\n\n[Install]\nWantedBy=default.target\n`,
    enable: ['systemctl', ['--user', 'enable', '--now', `${serviceName}.service`]],
    start: ['systemctl', ['--user', 'restart', `${serviceName}.service`]],
    stop: ['systemctl', ['--user', 'stop', `${serviceName}.service`]],
    disable: ['systemctl', ['--user', 'disable', '--now', `${serviceName}.service`]],
    reload: ['systemctl', ['--user', 'daemon-reload']],
  };
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
  });
}

async function exists(file) {
  return Boolean(file) && stat(file).then((info) => info.isFile()).catch(() => false);
}

export async function notifyDaemonAutostartStatus(spec, dependencies = {}) {
  let enabled;
  if (spec.platform === 'win32') {
    const run = dependencies.runCommand || runCommand;
    enabled = await run('schtasks.exe', ['/Query', '/TN', spec.taskName]).then(() => true).catch(() => false);
  } else {
    enabled = await exists(spec.file);
  }
  return { supported: true, enabled, serviceName: spec.serviceName, file: spec.file || null };
}

export async function enableNotifyDaemonAutostart(spec, dependencies = {}) {
  const run = dependencies.runCommand || runCommand;
  if (spec.file) {
    await mkdir(path.dirname(spec.file), { recursive: true });
    await writeFile(spec.file, spec.content, { mode: 0o600 });
    await chmod(spec.file, 0o600).catch(() => {});
  }
  if (spec.reload) await run(...spec.reload);
  if (spec.platform === 'darwin') await run(...spec.disable).catch(() => {});
  await run(...spec.enable);
  return { enabled: true, serviceName: spec.serviceName, file: spec.file || null };
}

export async function stopNotifyDaemonService(spec, dependencies = {}) {
  const run = dependencies.runCommand || runCommand;
  await run(...spec.stop).catch(() => {});
  return { stopped: true, serviceName: spec.serviceName };
}

export async function disableNotifyDaemonAutostart(spec, dependencies = {}) {
  const run = dependencies.runCommand || runCommand;
  await run(...spec.disable).catch(() => {});
  if (spec.file) await rm(spec.file, { force: true });
  if (spec.reload) await run(...spec.reload).catch(() => {});
  return { enabled: false, serviceName: spec.serviceName, file: spec.file || null };
}
