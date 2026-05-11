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
  const auth = config.auth || {};
  const email = config.email || config.smtp || {};
  const fanout = config.fanout_api || config.fanoutApi || {};
  const runtime = config.runtime || {};

  setEnv(env, 'HOST', server.host);
  setEnv(env, 'PORT', server.port);
  setEnv(env, 'MAGCLAW_PUBLIC_URL', pick(server.public_url, server.publicUrl));
  setEnv(env, 'MAGCLAW_DEPLOYMENT', server.deployment);
  setEnv(env, 'MAGCLAW_DATA_DIR', pick(server.data_dir, server.dataDir));
  setEnv(env, 'MAGCLAW_REQUIRE_POSTGRES', pick(server.require_postgres, server.requirePostgres));
  setEnv(env, 'MAGCLAW_REQUIRE_LOGIN', pick(auth.require_login, auth.requireLogin));
  setEnv(env, 'MAGCLAW_ALLOW_SIGNUPS', pick(auth.allow_signups, auth.allowSignups));
  setEnv(env, 'MAGCLAW_SESSION_SECRET', pick(auth.session_secret, auth.sessionSecret));

  setEnv(env, 'MAGCLAW_DATABASE_URL', pick(database.url, database.postgres_url, database.postgresUrl, database.connection_string, database.connectionString));
  setEnv(env, 'MAGCLAW_DATABASE', pick(database.name, database.database));
  setEnv(env, 'MAGCLAW_DATABASE_SCHEMA', database.schema);
  setEnv(env, 'MAGCLAW_MAINTENANCE_DATABASE', pick(database.maintenance_database, database.maintenanceDatabase));
  setEnv(env, 'MAGCLAW_DATABASE_CREATE', database.create);

  setEnv(env, 'MAGCLAW_ATTACHMENT_STORAGE', pick(storage.attachment_storage, storage.attachmentStorage));
  setEnv(env, 'MAGCLAW_UPLOAD_DIR', pick(storage.upload_dir, storage.uploadDir));
  setEnv(env, 'MAGCLAW_LOCAL_UPLOAD_DIR', pick(storage.local_upload_dir, storage.localUploadDir));
  setEnv(env, 'MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK', pick(storage.local_file_storage_fallback, storage.localFileStorageFallback));
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

  setEnv(env, 'MAGCLAW_FANOUT_API_ENABLED', fanout.enabled);
  setEnv(env, 'MAGCLAW_FANOUT_API_BASE_URL', pick(fanout.base_url, fanout.baseUrl));
  setEnv(env, 'MAGCLAW_FANOUT_API_KEY', pick(fanout.api_key, fanout.apiKey));
  setEnv(env, 'MAGCLAW_FANOUT_API_MODEL', fanout.model);
  setEnv(env, 'MAGCLAW_FANOUT_API_FALLBACK_MODEL', pick(fanout.fallback_model, fanout.fallbackModel));
  setEnv(env, 'MAGCLAW_FANOUT_TIMEOUT_MS', pick(fanout.timeout_ms, fanout.timeoutMs));

  setEnv(env, 'CODEX_MODEL', pick(runtime.codex_model, runtime.codexModel));
  setEnv(env, 'CODEX_PATH', pick(runtime.codex_path, runtime.codexPath));
  setEnv(env, 'MAGCLAW_CHAT_MODEL', pick(runtime.chat_model, runtime.chatModel));
  setEnv(env, 'MAGCLAW_CHAT_REASONING', pick(runtime.chat_reasoning, runtime.chatReasoning));

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
