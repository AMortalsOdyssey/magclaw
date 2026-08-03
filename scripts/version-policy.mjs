#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHANGE_TYPES = new Set(['fix', 'feature', 'breaking', 'stabilize', 'release']);
const PRERELEASE_STAGES = new Set(['alpha', 'beta', 'rc', 'dev', 'canary', 'next']);

function cleanText(value) {
  return String(value || '').trim();
}

export function parseSemver(value) {
  const version = cleanText(value);
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid SemVer: ${version || '(empty)'}`);
  if ((match[4] || '').split('.').some((identifier) => /^0\d+$/.test(identifier))) {
    throw new Error(`Invalid SemVer: ${version}`);
  }
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    build: match[5] || '',
  };
}

export function inferDistTag(version) {
  const parsed = parseSemver(version);
  if (!parsed.prerelease) return 'latest';
  const stage = parsed.prerelease.split('.')[0].toLowerCase();
  if (['alpha', 'dev', 'canary'].includes(stage)) return 'canary';
  return 'next';
}

function coreVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function incrementPrerelease(parsed, stage) {
  const identifiers = parsed.prerelease.split('.');
  if (identifiers[0]?.toLowerCase() !== stage) return `${coreVersion(parsed)}-${stage}.1`;
  const last = identifiers.at(-1);
  if (/^(0|[1-9]\d*)$/.test(last)) {
    identifiers[identifiers.length - 1] = String(Number(last) + 1);
  } else {
    identifiers.push('1');
  }
  return `${coreVersion(parsed)}-${identifiers.join('.')}`;
}

export function recommendVersion(options = {}) {
  const current = parseSemver(options.version);
  const change = cleanText(options.change).toLowerCase();
  const stage = cleanText(options.stage).toLowerCase();
  if (!CHANGE_TYPES.has(change)) {
    throw new Error(`Unsupported change type: ${change || '(empty)'}`);
  }
  if (stage && !PRERELEASE_STAGES.has(stage)) {
    throw new Error(`Unsupported prerelease stage: ${stage}`);
  }

  let target;
  let bump;
  if (change === 'release') {
    if (!current.prerelease) throw new Error('The release change type requires a prerelease current version.');
    if (stage) {
      const nextVersion = incrementPrerelease(current, stage);
      return {
        currentVersion: current.version,
        change,
        bump: 'prerelease',
        stage,
        nextVersion,
        distTag: inferDistTag(nextVersion),
      };
    }
    target = { major: current.major, minor: current.minor, patch: current.patch };
    bump = 'release';
  } else if (change === 'stabilize') {
    if (current.major !== 0) throw new Error('The stabilize change type is only valid for a 0.x package.');
    target = { major: 1, minor: 0, patch: 0 };
    bump = 'major';
  } else if (change === 'breaking') {
    target = current.major === 0
      ? { major: 0, minor: current.minor + 1, patch: 0 }
      : { major: current.major + 1, minor: 0, patch: 0 };
    bump = current.major === 0 ? 'minor-compatibility-line' : 'major';
  } else if (change === 'feature') {
    target = { major: current.major, minor: current.minor + 1, patch: 0 };
    bump = 'minor';
  } else {
    target = { major: current.major, minor: current.minor, patch: current.patch + 1 };
    bump = 'patch';
  }

  let nextVersion = coreVersion(target);
  if (stage) nextVersion = `${nextVersion}-${stage}.1`;
  return {
    currentVersion: current.version,
    change,
    bump,
    stage: stage || 'stable',
    nextVersion,
    distTag: inferDistTag(nextVersion),
  };
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, version: '', change: '', stage: '' };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--version') options.version = cleanText(rest[++index]);
    else if (arg.startsWith('--version=')) options.version = cleanText(arg.slice('--version='.length));
    else if (arg === '--change') options.change = cleanText(rest[++index]);
    else if (arg.startsWith('--change=')) options.change = cleanText(arg.slice('--change='.length));
    else if (arg === '--stage') options.stage = cleanText(rest[++index]);
    else if (arg.startsWith('--stage=')) options.stage = cleanText(arg.slice('--stage='.length));
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/version-policy.mjs recommend --version <semver> --change <fix|feature|breaking|stabilize|release> [--stage <alpha|beta|rc|dev|canary|next>]',
    '  node scripts/version-policy.mjs tag --version <semver>',
    '',
    'Policy: VERSIONING.md',
    'Returns JSON and never changes package manifests or publishes packages.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    console.log(usage());
    return;
  }
  if (options.command === 'tag') {
    console.log(JSON.stringify({ version: options.version, distTag: inferDistTag(options.version) }, null, 2));
    return;
  }
  if (options.command !== 'recommend') throw new Error(`Unknown command: ${options.command}`);
  console.log(JSON.stringify(recommendVersion(options), null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
