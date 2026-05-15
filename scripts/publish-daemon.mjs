#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DAEMON_DIR = path.join(ROOT, 'daemon');
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.magclaw', 'npm-token');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const skipVerify = args.includes('--skip-verify');
const otp = argValue('--otp');
const tokenFile = argValue('--token-file')
  || process.env.MAGCLAW_NPM_TOKEN_FILE
  || DEFAULT_TOKEN_FILE;

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  if (index >= 0) return String(args[index + 1] || '').trim();
  return '';
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${command} ${commandArgs.join(' ')} failed with exit ${result.status}`);
  }
  return String(result.stdout || '').trim();
}

function npmViewVersion(packageName) {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return String(result.stdout || '').trim();
  if (String(result.stderr || '').includes('E404')) return '';
  throw new Error(String(result.stderr || result.stdout || '').trim() || `npm view ${packageName} version failed`);
}

function readToken() {
  const fromEnv = String(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(tokenFile)) return '';
  return readFileSync(tokenFile, 'utf8').trim();
}

function withTemporaryNpmrc(token, callback) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'magclaw-npm-publish-'));
  const npmrcPath = path.join(tempDir, '.npmrc');
  try {
    writeFileSync(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    chmodSync(npmrcPath, 0o600);
    return callback(npmrcPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const daemonPackage = readJson(path.join(DAEMON_DIR, 'package.json'));
  const packageName = String(daemonPackage.name || '').trim();
  const version = String(daemonPackage.version || '').trim();
  if (packageName !== '@magclaw/daemon') throw new Error(`Unexpected daemon package name: ${packageName}`);
  if (!version) throw new Error('Daemon package version is missing.');

  console.log(`[daemon:publish] package=${packageName} version=${version}`);
  const publishedVersion = npmViewVersion(packageName);
  if (publishedVersion) console.log(`[daemon:publish] registry latest=${publishedVersion}`);

  console.log('[daemon:publish] running package dry-run...');
  run('npm', ['pack', '--dry-run', '--json', './daemon']);

  if (dryRun) {
    console.log('[daemon:publish] dry-run complete; publish was not attempted.');
    return;
  }

  if (publishedVersion === version && !force) {
    console.log(`[daemon:publish] ${packageName}@${version} is already published. Use --force only if npm allows a retry.`);
    return;
  }

  const token = readToken();
  if (!token) {
    throw new Error([
      'NPM token is missing.',
      'Set NPM_TOKEN for one run, or save it to ~/.magclaw/npm-token with chmod 600.',
      'You can also pass --token-file <path> or set MAGCLAW_NPM_TOKEN_FILE.',
    ].join(' '));
  }

  withTemporaryNpmrc(token, (npmrcPath) => {
    const publishArgs = ['publish', './daemon', '--access', 'public'];
    if (otp) publishArgs.push(`--otp=${otp}`);
    run('npm', publishArgs, {
      env: {
        NPM_CONFIG_USERCONFIG: npmrcPath,
      },
    });
  });

  if (!skipVerify) {
    const nextVersion = npmViewVersion(packageName);
    if (nextVersion !== version) {
      throw new Error(`Published version verification failed: expected ${version}, got ${nextVersion || 'empty'}`);
    }
    console.log(`[daemon:publish] verified registry latest=${nextVersion}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[daemon:publish] ${error.message}`);
  process.exitCode = 1;
}
