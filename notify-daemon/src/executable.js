import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function executableExtensions(platform, env) {
  if (platform !== 'win32') return [''];
  return unique(String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((value) => value.toLowerCase()));
}

function executableFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

export function notifyExecutableSearchPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const nodePath = options.nodePath || process.execPath;
  const configured = String(options.pathEnv ?? env.PATH ?? '').split(path.delimiter);
  const common = platform === 'win32'
    ? [
        path.dirname(nodePath),
        env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
        path.join(homeDir, 'AppData', 'Roaming', 'npm'),
        env.SystemRoot ? path.join(env.SystemRoot, 'System32') : '',
      ]
    : [
        path.dirname(nodePath),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, '.npm-global', 'bin'),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ];
  return unique([...configured, ...common]
    .map((value) => String(value || '').trim())
    .filter((value) => path.isAbsolute(value) && !value.includes(`${path.sep}node_modules${path.sep}.bin`)))
    .join(path.delimiter);
}

export function resolveNotifyExecutable(command, options = {}) {
  const value = String(command || '').trim();
  if (!value || path.isAbsolute(value) || value.includes('/') || value.includes('\\')) return value;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const searchPath = notifyExecutableSearchPath(options);
  for (const directory of searchPath.split(path.delimiter)) {
    for (const extension of executableExtensions(platform, env)) {
      const candidate = path.join(directory, platform === 'win32' ? `${value}${extension}` : value);
      if (executableFile(candidate)) return candidate;
    }
  }
  return value;
}
