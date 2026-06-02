#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGE_DIRS = Object.freeze([
  ['@magclaw/cli-core', 'cli-core'],
  ['@magclaw/daemon', 'daemon'],
  ['@magclaw/computer', 'computer'],
  ['@magclaw/team-sharing', 'team-sharing'],
]);
const MAGCLAW_RELEASE_PACKAGE_NAMES = Object.freeze(DEFAULT_PACKAGE_DIRS.map(([name]) => name));
const CLI_CORE_PACKAGE_NAME = '@magclaw/cli-core';
const CLI_CORE_DEPENDENT_PACKAGE_NAMES = Object.freeze(['@magclaw/daemon', '@magclaw/computer']);
const CLI_CORE_VERSION_LOCKED_PACKAGE_NAMES = Object.freeze(['@magclaw/daemon', '@magclaw/computer']);

function cleanText(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makePublishId() {
  return `pkgrel_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function parseJsonOutput(stdout, fallback = null) {
  const text = cleanText(stdout);
  if (!text) return fallback;
  return JSON.parse(text);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function packageVersionFromNpmResult(result) {
  if (typeof result === 'string') return result;
  return cleanText(result?.version || result?.latest);
}

function verifyNpmPackage(pkg, npmResult) {
  const version = packageVersionFromNpmResult(npmResult);
  if (version !== pkg.version) {
    throw new Error(`npm registry returned ${pkg.name}@${version || 'unknown'}, expected ${pkg.version}.`);
  }
  const latest = cleanText(npmResult?.distTags?.latest || npmResult?.['dist-tags']?.latest);
  if (latest && latest !== pkg.version) {
    throw new Error(`npm latest dist-tag for ${pkg.name} is ${latest}, expected ${pkg.version}.`);
  }
}

function wrapReleaseError(phase, error, publishId) {
  const detail = cleanText(error?.message || error);
  const wrapped = new Error(`${phase} failed for ${publishId}: ${detail}.`);
  wrapped.cause = error;
  wrapped.phase = phase;
  wrapped.publishId = publishId;
  return wrapped;
}

export async function runPackagePublishRelease(options = {}) {
  const packages = safeArray(options.packages).map((pkg) => ({
    name: cleanText(pkg.name),
    version: cleanText(pkg.version),
    dir: cleanText(pkg.dir),
  })).filter((pkg) => pkg.name && pkg.version);
  if (!packages.length) throw new Error('No MagClaw packages selected for release.');

  const logger = options.logger || console;
  const publishId = options.publishId || makePublishId();
  const registryUrl = cleanText(options.registryUrl);
  const dryRun = Boolean(options.dryRun);
  const verifyOnly = Boolean(options.verifyOnly || options.syncOnly);
  const npmPublish = options.npmPublish || defaultNpmPublish;
  const npmVerify = options.npmVerify || defaultNpmVerify;
  const packDryRun = options.packDryRun || defaultNpmPackDryRun;
  const verified = [];
  let phase = 'init';

  try {
    if (dryRun) {
      phase = 'npm-pack-dry-run';
      for (const pkg of packages) {
        logger.info?.(`[packages:publish] dry-run packing ${pkg.name}@${pkg.version}`);
        await packDryRun(pkg, { registryUrl });
      }
      return { ok: true, dryRun: true, publishId, packages };
    }

    for (const pkg of packages) {
      if (!verifyOnly) {
        phase = 'npm-publish';
        logger.info?.(`[packages:publish] publishing ${pkg.name}@${pkg.version}`);
        await npmPublish(pkg, { registryUrl, publishId });
      } else {
        logger.info?.(`[packages:publish] verify-only checking ${pkg.name}@${pkg.version}`);
      }

      phase = 'npm-verify';
      const npmResult = await npmVerify(pkg, { registryUrl, publishId });
      verifyNpmPackage(pkg, npmResult);
      verified.push({ packageName: pkg.name, version: pkg.version, npm: npmResult });
    }

    logger.info?.(`[packages:publish] completed ${publishId}`);
    return { ok: true, publishId, packages, verified, verifyOnly };
  } catch (error) {
    throw wrapReleaseError(phase, error, publishId);
  }
}

export async function collectReleasePackages(options = {}) {
  const root = options.root || process.cwd();
  const selected = new Set(safeArray(options.packageNames).map(cleanText).filter(Boolean));
  if (selected.has(CLI_CORE_PACKAGE_NAME)) {
    for (const name of CLI_CORE_DEPENDENT_PACKAGE_NAMES) selected.add(name);
  }
  const packages = [];
  for (const [expectedName, dirName] of DEFAULT_PACKAGE_DIRS) {
    if (selected.size && !selected.has(expectedName)) continue;
    const dir = path.join(root, dirName);
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== expectedName) {
      throw new Error(`Package ${dirName} is ${pkg.name || 'unnamed'}, expected ${expectedName}.`);
    }
    packages.push({ name: pkg.name, version: cleanText(pkg.version), dir, manifest: pkg });
  }
  if (selected.size) {
    const known = new Set(MAGCLAW_RELEASE_PACKAGE_NAMES);
    for (const name of selected) {
      if (!known.has(name)) throw new Error(`Unsupported package: ${name}`);
    }
  }
  validateCliCoreReleaseSet(packages);
  return packages;
}

function validateCliCoreReleaseSet(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const cliCore = byName.get(CLI_CORE_PACKAGE_NAME);
  if (!cliCore) return;
  const versionLocked = new Set(CLI_CORE_VERSION_LOCKED_PACKAGE_NAMES);
  for (const dependentName of CLI_CORE_DEPENDENT_PACKAGE_NAMES) {
    const dependent = byName.get(dependentName);
    if (!dependent) {
      throw new Error(`${dependentName} must be released with ${CLI_CORE_PACKAGE_NAME}.`);
    }
    if (versionLocked.has(dependentName) && dependent.version !== cliCore.version) {
      throw new Error(`${dependentName} version ${dependent.version} must match ${CLI_CORE_PACKAGE_NAME} ${cliCore.version}.`);
    }
    const dependencyVersion = cleanText(dependent.manifest?.dependencies?.[CLI_CORE_PACKAGE_NAME]);
    if (dependencyVersion !== cliCore.version) {
      throw new Error(`${dependentName} depends on ${CLI_CORE_PACKAGE_NAME}@${dependencyVersion || 'missing'}, expected ${cliCore.version}.`);
    }
  }
}

export function parsePublishArgs(argv = []) {
  const options = {
    dryRun: false,
    verifyOnly: false,
    syncOnly: false,
    packageNames: [],
    registryUrl: '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--sync-only') {
      options.syncOnly = true;
      options.verifyOnly = true;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--registry') options.registryUrl = cleanText(argv[++index]);
    else if (arg.startsWith('--registry=')) options.registryUrl = cleanText(arg.slice('--registry='.length));
    else if (arg === '--package') options.packageNames.push(cleanText(argv[++index]));
    else if (arg.startsWith('--package=')) options.packageNames.push(cleanText(arg.slice('--package='.length)));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.dryRun && options.verifyOnly) throw new Error('--dry-run and --verify-only/--sync-only cannot be used together.');
  return options;
}

async function defaultNpmPackDryRun(pkg, options = {}) {
  const args = ['pack', '--dry-run', '--json', pkg.dir];
  if (options.registryUrl) args.push('--registry', options.registryUrl);
  const result = await runCommand('npm', args);
  return parseJsonOutput(result.stdout, []);
}

async function defaultNpmPublish(pkg, options = {}) {
  const args = ['publish', pkg.dir, '--access', 'public', '--tag', 'latest'];
  if (options.registryUrl) args.push('--registry', options.registryUrl);
  return runCommand('npm', args);
}

async function defaultNpmVerify(pkg, options = {}) {
  const spec = `${pkg.name}@${pkg.version}`;
  const viewArgs = ['view', spec, 'version', '--json'];
  const tagArgs = ['view', pkg.name, 'dist-tags', '--json'];
  if (options.registryUrl) {
    viewArgs.push('--registry', options.registryUrl);
    tagArgs.push('--registry', options.registryUrl);
  }
  const versionResult = await runCommand('npm', viewArgs);
  const tagResult = await runCommand('npm', tagArgs);
  return {
    packageName: pkg.name,
    version: packageVersionFromNpmResult(parseJsonOutput(versionResult.stdout, '')),
    distTags: parseJsonOutput(tagResult.stdout, {}),
  };
}

function usage() {
  return [
    'Usage: node scripts/publish-magclaw-packages.mjs [--dry-run|--verify-only|--sync-only] [--package <name>] [--registry <url>]',
    '',
    'Publishes selected MagClaw npm packages, then verifies npm latest dist-tags.',
    'If @magclaw/cli-core is selected, @magclaw/daemon and @magclaw/computer are included so shared daemon/computer CLI changes ship with both entry packages.',
    '@magclaw/team-sharing is a standalone package; publish it explicitly with --package @magclaw/team-sharing.',
    '--verify-only verifies already-published npm versions without publishing; --sync-only is kept as a deprecated alias.',
    'No production database access is required.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parsePublishArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packages = await collectReleasePackages({ root, packageNames: options.packageNames });
  await runPackagePublishRelease({
    packages,
    dryRun: options.dryRun,
    verifyOnly: options.verifyOnly,
    registryUrl: options.registryUrl,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
