#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPackageVersionManifestStore,
  MAGCLAW_RELEASE_PACKAGE_NAMES,
} from '../server/package-version-manifest.js';
import {
  DEFAULT_DATABASE,
  DEFAULT_MAINTENANCE_DATABASE,
  DEFAULT_SCHEMA,
  databaseNameFromUrl,
  migratePostgres,
  normalizeDatabaseUrl,
  postgresRuntimeOptionsFromEnv,
} from '../server/cloud/postgres.js';

const DEFAULT_PACKAGE_DIRS = Object.freeze([
  ['@magclaw/cli-core', 'cli-core'],
  ['@magclaw/daemon', 'daemon'],
  ['@magclaw/computer', 'computer'],
]);
const CLI_CORE_PACKAGE_NAME = '@magclaw/cli-core';
const CLI_CORE_DEPENDENT_PACKAGE_NAMES = Object.freeze(['@magclaw/daemon', '@magclaw/computer']);

function cleanText(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
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

function releaseRecord(pkg, context = {}) {
  return {
    packageName: pkg.name,
    version: pkg.version,
    channel: 'latest',
    publishId: context.publishId || '',
    npmVerifiedAt: context.npmVerifiedAt || null,
    metadata: {
      packageDir: pkg.dir || '',
      npm: context.npm || null,
      registry: context.registryUrl || '',
    },
  };
}

function releaseRecords(packages, context = {}) {
  return packages.map((pkg) => releaseRecord(pkg, context));
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

async function verifyDbPublished(manifestStore, packages) {
  const rows = await manifestStore.read(packages.map((pkg) => pkg.name), { publishedOnly: true });
  const byName = new Map(rows.map((row) => [row.packageName, row]));
  for (const pkg of packages) {
    const record = byName.get(pkg.name);
    if (!record) throw new Error(`DB manifest is missing published ${pkg.name}@${pkg.version}.`);
    if (record.version !== pkg.version) {
      throw new Error(`DB manifest has ${pkg.name}@${record.version}, expected ${pkg.version}.`);
    }
    if (record.status && record.status !== 'published') {
      throw new Error(`DB manifest has ${pkg.name} status ${record.status}, expected published.`);
    }
  }
}

function wrapReleaseError(phase, error, publishId) {
  const detail = cleanText(error?.message || error);
  const recovery = phase === 'db-published' || phase === 'db-verify'
    ? ' NPM may already be published; run: node scripts/publish-magclaw-packages.mjs --sync-only'
    : '';
  const wrapped = new Error(`${phase} failed for ${publishId}: ${detail}.${recovery}`);
  wrapped.cause = error;
  wrapped.phase = phase;
  wrapped.publishId = publishId;
  return wrapped;
}

async function bestEffortMarkFailed(manifestStore, records, context, logger) {
  try {
    await manifestStore.markFailed(records, context);
  } catch (error) {
    logger?.error?.(`[packages:publish] failed to mark DB manifest failed: ${error.message || error}`);
  }
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
  const syncOnly = Boolean(options.syncOnly);
  const manifestStore = options.manifestStore;
  const npmPublish = options.npmPublish || defaultNpmPublish;
  const npmVerify = options.npmVerify || defaultNpmVerify;
  const packDryRun = options.packDryRun || defaultNpmPackDryRun;
  const records = releaseRecords(packages, { publishId, registryUrl });
  let phase = 'init';
  const verifiedRecords = [];

  if (dryRun) {
    phase = 'npm-pack-dry-run';
    for (const pkg of packages) {
      logger.info?.(`[packages:publish] dry-run packing ${pkg.name}@${pkg.version}`);
      await packDryRun(pkg, { registryUrl });
    }
    return { ok: true, dryRun: true, publishId, packages };
  }

  if (!manifestStore) throw new Error('A DB manifest store is required for package publishing.');

  try {
    if (!syncOnly) {
      phase = 'db-pending';
      await manifestStore.markPending(records, { publishId, now: nowIso() });
    }

    for (const pkg of packages) {
      if (!syncOnly) {
        phase = 'npm-publish';
        logger.info?.(`[packages:publish] publishing ${pkg.name}@${pkg.version}`);
        await npmPublish(pkg, { registryUrl, publishId });
      } else {
        logger.info?.(`[packages:publish] sync-only verifying ${pkg.name}@${pkg.version}`);
      }

      phase = 'npm-verify';
      const npmResult = await npmVerify(pkg, { registryUrl, publishId });
      verifyNpmPackage(pkg, npmResult);
      verifiedRecords.push(releaseRecord(pkg, {
        publishId,
        registryUrl,
        npmVerifiedAt: nowIso(),
        npm: npmResult,
      }));
    }

    phase = 'db-published';
    await manifestStore.markPublished(verifiedRecords, { publishId, now: nowIso() });

    phase = 'db-verify';
    await verifyDbPublished(manifestStore, packages);

    logger.info?.(`[packages:publish] completed ${publishId}`);
    return { ok: true, publishId, packages };
  } catch (error) {
    const wrapped = wrapReleaseError(phase, error, publishId);
    if (['npm-publish', 'npm-verify', 'db-published'].includes(phase)) {
      await bestEffortMarkFailed(manifestStore, records, {
        publishId,
        now: nowIso(),
        error: wrapped.message,
      }, logger);
    }
    throw wrapped;
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
  for (const dependentName of CLI_CORE_DEPENDENT_PACKAGE_NAMES) {
    const dependent = byName.get(dependentName);
    if (!dependent) {
      throw new Error(`${dependentName} must be released with ${CLI_CORE_PACKAGE_NAME}.`);
    }
    if (dependent.version !== cliCore.version) {
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
    syncOnly: false,
    packageNames: [],
    registryUrl: '',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--sync-only') options.syncOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--registry') options.registryUrl = cleanText(argv[++index]);
    else if (arg.startsWith('--registry=')) options.registryUrl = cleanText(arg.slice('--registry='.length));
    else if (arg === '--package') options.packageNames.push(cleanText(argv[++index]));
    else if (arg.startsWith('--package=')) options.packageNames.push(cleanText(arg.slice('--package='.length)));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.dryRun && options.syncOnly) throw new Error('--dry-run and --sync-only cannot be used together.');
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

async function createManifestStoreFromEnv(env = process.env) {
  const databaseUrl = normalizeDatabaseUrl(env.MAGCLAW_DATABASE_URL || '');
  if (!databaseUrl) {
    throw new Error('MAGCLAW_DATABASE_URL is required to publish MagClaw packages with DB manifest sync.');
  }
  const database = env.MAGCLAW_DATABASE || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE);
  const schema = env.MAGCLAW_DATABASE_SCHEMA || DEFAULT_SCHEMA;
  const maintenanceDatabase = env.MAGCLAW_MAINTENANCE_DATABASE || DEFAULT_MAINTENANCE_DATABASE;
  await migratePostgres({
    databaseUrl,
    database,
    schema,
    maintenanceDatabase,
    createDatabase: env.MAGCLAW_DATABASE_CREATE !== '0',
    runtimeOptions: postgresRuntimeOptionsFromEnv(env),
  });
  return createPackageVersionManifestStore({
    databaseUrl,
    database,
    schema,
    poolMax: 1,
  });
}

function usage() {
  return [
    'Usage: node scripts/publish-magclaw-packages.mjs [--dry-run|--sync-only] [--package <name>] [--registry <url>]',
    '',
    'Publishes @magclaw/cli-core, @magclaw/daemon, and @magclaw/computer, then writes the DB version manifest.',
    '--sync-only skips npm publish and reconciles DB from already-published npm versions.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parsePublishArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packages = await collectReleasePackages({ root, packageNames: options.packageNames });
  if (options.dryRun) {
    await runPackagePublishRelease({
      packages,
      dryRun: true,
      registryUrl: options.registryUrl,
    });
    return;
  }

  const manifestStore = await createManifestStoreFromEnv(env);
  try {
    await runPackagePublishRelease({
      packages,
      manifestStore,
      syncOnly: options.syncOnly,
      registryUrl: options.registryUrl,
    });
  } finally {
    await manifestStore.close?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
