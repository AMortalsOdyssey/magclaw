import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function stripInlineComment(value) {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? '' : quote || char;
      continue;
    }
    if (char === '#' && !quote && /\s/.test(value[index - 1] || ' ')) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseScalar(rawValue) {
  const value = stripInlineComment(String(rawValue || '').trim());
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part.trim()))
      .filter((part) => part !== '');
  }
  return value;
}

export function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const line = rawLine.trim();
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const rawValue = match[2] || '';
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (!rawValue.trim()) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }
  return root;
}

function setEnv(env, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (env[key] !== undefined) return;
  env[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function joinNameAndAddress(name, address) {
  const cleanAddress = String(address || '').trim();
  if (!cleanAddress) return '';
  const cleanName = String(name || '').trim();
  return cleanName ? `${cleanName} <${cleanAddress}>` : cleanAddress;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function candidateConfigPaths({ env = process.env, homeDir = os.homedir() } = {}) {
  const explicit = [
    env.MAGCLAW_CONFIG,
    env.MAGCLAW_CONFIG_FILE,
  ].filter(Boolean);
  if (explicit.length) return explicit;
  return [
    path.join(homeDir, '.magclaw-server', 'server.yaml'),
    path.join(homeDir, '.magclaw', 'server.yaml'),
    '/etc/magclaw/server.yaml',
  ].filter(Boolean);
}

export function applyServerYamlConfig(options = {}) {
  const env = options.env || process.env;
  const paths = options.paths || candidateConfigPaths(options);
  const configPath = paths.find((item) => existsSync(item));
  if (!configPath) return { loaded: false, config: {}, path: '' };

  const config = parseSimpleYaml(readFileSync(configPath, 'utf8'));
  const server = config.server || {};
  const database = config.database || config.postgres || {};
  const storage = config.storage || {};
  const email = config.email || config.smtp || {};
  const runtime = config.runtime || {};
  const daemon = config.daemon || {};
  const rawDaemonConnectCommand = pick(daemon.connect_command, daemon.connectCommand);
  const daemonConnectCommand = objectValue(rawDaemonConnectCommand);
  const daemonConnectCommandTemplate = typeof rawDaemonConnectCommand === 'string'
    ? rawDaemonConnectCommand
    : pick(daemonConnectCommand.template, daemonConnectCommand.command);
  const rawLocalFileStorageFallback = pick(storage.local_file_storage_fallback, storage.localFileStorageFallback);
  const localFileStorageFallback = objectValue(rawLocalFileStorageFallback);
  const localFileStorageFallbackEnabled = Object.keys(localFileStorageFallback).length
    ? pick(localFileStorageFallback.enabled, localFileStorageFallback.enable)
    : rawLocalFileStorageFallback;

  setEnv(env, 'HOST', server.host);
  setEnv(env, 'PORT', server.port);
  setEnv(env, 'MAGCLAW_PUBLIC_URL', pick(server.public_url, server.publicUrl));
  setEnv(env, 'MAGCLAW_DEPLOYMENT', server.deployment);
  setEnv(env, 'MAGCLAW_REQUIRE_POSTGRES', pick(server.require_postgres, server.requirePostgres));

  setEnv(env, 'MAGCLAW_DATABASE_URL', pick(database.url, database.postgres_url, database.postgresUrl, database.connection_string, database.connectionString));
  setEnv(env, 'MAGCLAW_DATABASE', pick(database.name, database.database));
  setEnv(env, 'MAGCLAW_DATABASE_SCHEMA', database.schema);
  setEnv(env, 'MAGCLAW_MAINTENANCE_DATABASE', pick(database.maintenance_database, database.maintenanceDatabase));
  setEnv(env, 'MAGCLAW_DATABASE_CREATE', database.create);
  setEnv(env, 'MAGCLAW_DATABASE_LOCK_TIMEOUT_MS', pick(database.lock_timeout_ms, database.lockTimeoutMs));
  setEnv(env, 'MAGCLAW_DATABASE_STATEMENT_TIMEOUT_MS', pick(database.statement_timeout_ms, database.statementTimeoutMs));
  setEnv(env, 'MAGCLAW_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', pick(
    database.idle_in_transaction_timeout_ms,
    database.idleInTransactionTimeoutMs,
    database.idle_in_transaction_session_timeout_ms,
    database.idleInTransactionSessionTimeoutMs,
  ));
  setEnv(env, 'MAGCLAW_DATABASE_STARTUP_LOCK_TIMEOUT_MS', pick(
    database.startup_lock_timeout_ms,
    database.startupLockTimeoutMs,
  ));
  setEnv(env, 'MAGCLAW_DATABASE_CONNECT_TIMEOUT_MS', pick(database.connect_timeout_ms, database.connectTimeoutMs));
  setEnv(env, 'MAGCLAW_DATABASE_POOL_MAX', pick(database.pool_max, database.poolMax));

  setEnv(env, 'MAGCLAW_ATTACHMENT_STORAGE', pick(storage.attachment_storage, storage.attachmentStorage));
  setEnv(env, 'MAGCLAW_UPLOAD_DIR', pick(storage.upload_dir, storage.uploadDir));
  setEnv(env, 'MAGCLAW_LOCAL_UPLOAD_DIR', pick(
    localFileStorageFallback.dir,
    localFileStorageFallback.path,
    localFileStorageFallback.upload_dir,
    localFileStorageFallback.uploadDir,
    storage.local_file_storage_fallback_dir,
    storage.localFileStorageFallbackDir,
    storage.local_upload_dir,
    storage.localUploadDir,
  ));
  setEnv(env, 'MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK', pick(
    localFileStorageFallbackEnabled,
  ));
  setEnv(env, 'MAGCLAW_WRITE_STATE_JSON', pick(storage.write_state_json, storage.writeStateJson));

  setEnv(env, 'MAGCLAW_MAIL_TRANSPORT', email.transport);
  setEnv(env, 'MAGCLAW_SMTP_HOST', pick(email.smtp_host, email.host));
  setEnv(env, 'MAGCLAW_SMTP_PORT', pick(email.smtp_port, email.port));
  setEnv(env, 'MAGCLAW_SMTP_USER', pick(email.smtp_username, email.username, email.user));
  setEnv(env, 'MAGCLAW_SMTP_PASSWORD', pick(email.smtp_password, email.password));
  setEnv(env, 'MAGCLAW_SMTP_SECURE', email.smtp_secure ?? email.secure);
  setEnv(env, 'MAGCLAW_SMTP_STARTTLS', email.smtp_tls ?? email.starttls);
  setEnv(env, 'MAGCLAW_MAIL_FROM', pick(email.from, joinNameAndAddress(email.from_name, email.from_address)));
  setEnv(env, 'MAGCLAW_MAIL_LOGO_URL', pick(email.logo_url, email.logoUrl));

  setEnv(env, 'CODEX_MODEL', pick(runtime.codex_model, runtime.codexModel));
  setEnv(env, 'CODEX_PATH', pick(runtime.codex_path, runtime.codexPath));
  setEnv(env, 'MAGCLAW_CHAT_MODEL', pick(runtime.chat_model, runtime.chatModel));
  setEnv(env, 'MAGCLAW_CHAT_REASONING', pick(runtime.chat_reasoning, runtime.chatReasoning));

  setEnv(env, 'MAGCLAW_DAEMON_COMMAND_MODE', pick(
    daemon.command_mode,
    daemon.commandMode,
    daemon.connect_command_mode,
    daemon.connectCommandMode,
    daemonConnectCommand.mode,
    daemonConnectCommand.command_mode,
    daemonConnectCommand.commandMode,
  ));
  setEnv(env, 'MAGCLAW_DAEMON_LOCAL_REPO_PLACEHOLDER', pick(
    daemon.local_repo_placeholder,
    daemon.localRepoPlaceholder,
    daemon.local_repo_dir,
    daemon.localRepoDir,
    daemonConnectCommand.local_repo_placeholder,
    daemonConnectCommand.localRepoPlaceholder,
    daemonConnectCommand.local_repo_dir,
    daemonConnectCommand.localRepoDir,
  ));
  setEnv(env, 'MAGCLAW_DAEMON_CONNECT_COMMAND', pick(
    daemon.connect_command_template,
    daemon.connectCommandTemplate,
    daemonConnectCommandTemplate,
  ));

  return { loaded: true, config, path: configPath };
}

export function redactConfig(config = {}) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  for (const section of Object.values(clone)) {
    if (!section || typeof section !== 'object') continue;
    for (const key of Object.keys(section)) {
      if (/password|secret|api_?key|token|url/i.test(key) && section[key]) {
        section[key] = '[redacted]';
      }
    }
  }
  return clone;
}
