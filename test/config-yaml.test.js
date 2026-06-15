import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyParsedServerYamlConfig, parseSimpleYaml, SERVER_CONFIG_PATH } from '../server/config-yaml.js';

function applyConfig(yaml, env = {}) {
  return applyParsedServerYamlConfig(parseSimpleYaml(yaml), { env, path: SERVER_CONFIG_PATH });
}

test('server yaml ignores runtime-scoped login data dir and fan-out settings', async () => {
  const env = {};
  const result = applyConfig(`
server:
  host: "0.0.0.0"
  port: 6543
  deployment: "cloud"
  data_dir: "/ignored/from/server"
auth:
  require_login: true
database:
  postgres_url: "postgresql://user:pass@db:5432/magclaw"
  lock_timeout_ms: 1234
  statement_timeout_ms: 5678
  idle_in_transaction_timeout_ms: 4321
  startup_lock_timeout_ms: 8765
  connect_timeout_ms: 2222
  pool_max: 7
storage:
  attachment_storage: "pvc"
  local_file_storage_fallback:
    enabled: true
    dir: "/tmp/magclaw-fallback"
daemon:
  connect_command:
    mode: "npm"
    local_repo_placeholder: "/workspace/magclaw"
llm:
  base_url: "https://llm.example/v1"
  api_key: "llm-secret"
  model: "qwen-test"
  timeout_ms: 12000
markdown_maintenance:
  enabled: true
  interval_ms: 60000
  startup_delay_ms: 5000
  semantic: false
  max_agents: 3
  max_files_per_agent: 4
knowledge:
  secret_key: "knowledge-secret"
  allow_open: false
fanout_api:
  enabled: true
  base_url: "https://models.example/v1"
  model: "qwen-test"
  fallback_model: "deepseek-test"
  timeout_ms: 9000
  api_key: "secret"
`, env);

  assert.equal(result.loaded, true);
  assert.equal(env.MAGCLAW_DATABASE_URL, 'postgresql://user:pass@db:5432/magclaw');
  assert.equal(env.MAGCLAW_DATABASE_LOCK_TIMEOUT_MS, '1234');
  assert.equal(env.MAGCLAW_DATABASE_STATEMENT_TIMEOUT_MS, '5678');
  assert.equal(env.MAGCLAW_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS, '4321');
  assert.equal(env.MAGCLAW_DATABASE_STARTUP_LOCK_TIMEOUT_MS, '8765');
  assert.equal(env.MAGCLAW_DATABASE_CONNECT_TIMEOUT_MS, '2222');
  assert.equal(env.MAGCLAW_DATABASE_POOL_MAX, '7');
  assert.equal(env.MAGCLAW_ATTACHMENT_STORAGE, 'pvc');
  assert.equal(env.MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK, '1');
  assert.equal(env.MAGCLAW_LOCAL_UPLOAD_DIR, '/tmp/magclaw-fallback');
  assert.equal(env.MAGCLAW_DAEMON_COMMAND_MODE, 'npm');
  assert.equal(env.MAGCLAW_DAEMON_LOCAL_REPO_PLACEHOLDER, '/workspace/magclaw');
  assert.equal(env.MAGCLAW_LLM_BASE_URL, 'https://llm.example/v1');
  assert.equal(env.MAGCLAW_LLM_API_KEY, 'llm-secret');
  assert.equal(env.MAGCLAW_LLM_MODEL, 'qwen-test');
  assert.equal(env.MAGCLAW_LLM_TIMEOUT_MS, '12000');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_ENABLED, '1');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_INTERVAL_MS, '60000');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_STARTUP_DELAY_MS, '5000');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_SEMANTIC, '0');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_MAX_AGENTS, '3');
  assert.equal(env.MAGCLAW_MARKDOWN_MAINTENANCE_MAX_FILES_PER_AGENT, '4');
  assert.equal(env.MAGCLAW_KNOWLEDGE_SECRET_KEY, 'knowledge-secret');
  assert.equal(env.MAGCLAW_ALLOW_OPEN_KNOWLEDGE, '0');
  assert.equal(env.MAGCLAW_REQUIRE_LOGIN, undefined);
  assert.equal(env.MAGCLAW_DATA_DIR, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_ENABLED, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_BASE_URL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_KEY, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_MODEL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_FALLBACK_MODEL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_TIMEOUT_MS, undefined);
  assert.equal(result.redacted.llm.api_key, '[redacted]');
  assert.equal(result.redacted.knowledge.secret_key, '[redacted]');
});

test('server yaml maps modular auth providers without exposing nested secrets in redaction', async () => {
  const env = {};
  const result = applyConfig(`
auth:
  providers:
    - type: email_password
      label: "Email password"
    - type: feishu
      label: "Feishu"
      app_id: "cli_test"
      app_secret: "super-secret"
      redirect_uri: "https://magclaw.example.com/api/cloud/auth/feishu/callback"
`, env);

  assert.equal(result.loaded, true);
  const providers = JSON.parse(env.MAGCLAW_AUTH_PROVIDERS);
  assert.deepEqual(providers, [
    { type: 'email_password', label: 'Email password' },
    {
      type: 'feishu',
      label: 'Feishu',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  assert.equal(result.config.auth.providers[1].app_secret, 'super-secret');
  assert.equal(result.redacted.auth.providers[1].app_secret, '[redacted]');
});

test('server yaml maps Feishu Connect Bot config separately from OAuth providers', async () => {
  const env = {};
  const result = applyConfig(`
auth:
  providers:
    - type: feishu
      app_id: "cli_oauth"
      app_secret: "oauth-secret"
      redirect_uri: "https://magclaw.example.com/api/cloud/auth/feishu/callback"
feishu:
  connect:
    enabled: true
    tenant: "feishu"
    app_id: "cli_connect"
    app_secret: "connect-secret"
    message_mode: "long_connection"
    reply_mode: "card"
`, env);

  assert.equal(result.loaded, true);
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_ENABLED, '1');
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_TENANT, 'feishu');
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_APP_ID, 'cli_connect');
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_APP_SECRET, 'connect-secret');
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_MESSAGE_MODE, 'long_connection');
  assert.equal(env.MAGCLAW_FEISHU_CONNECT_REPLY_MODE, 'card');
  const providers = JSON.parse(env.MAGCLAW_AUTH_PROVIDERS);
  assert.equal(providers[0].app_id, 'cli_oauth');
  assert.equal(providers[0].app_secret, 'oauth-secret');
  assert.equal(result.redacted.feishu.connect.app_secret, '[redacted]');
  assert.equal(result.redacted.auth.providers[0].app_secret, '[redacted]');
});

test('server yaml maps team sharing and platform AI services without exposing secrets in redaction', async () => {
  const env = {};
  const result = applyConfig(`
team_sharing:
  enabled: true

embedding:
  base_url: "https://embedding.example/v1"
  api_key: "embedding-secret"
  model: "embedding-model"
  preferred_dimension: 1536

zilliz:
  endpoint: "https://zilliz.example"
  token: "zilliz-secret"
  database: "ai_social_memory"
  collection: "magclaw_team_sharing_v1"

rerank:
  url: "https://rerank.example/v1/rerank"
  api_key: "rerank-secret"
  candidate_k: 40
  top_n: 5
`, env);

  assert.equal(result.loaded, true);
  assert.equal(env.MAGCLAW_TEAM_SHARING_ENABLED, '1');
  assert.equal(env.MAGCLAW_EMBEDDING_BASE_URL, 'https://embedding.example/v1');
  assert.equal(env.MAGCLAW_EMBEDDING_API_KEY, 'embedding-secret');
  assert.equal(env.MAGCLAW_EMBEDDING_MODEL, 'embedding-model');
  assert.equal(env.MAGCLAW_EMBEDDING_PREFERRED_DIMENSION, '1536');
  assert.equal(env.MAGCLAW_ZILLIZ_ENDPOINT, 'https://zilliz.example');
  assert.equal(env.MAGCLAW_ZILLIZ_TOKEN, 'zilliz-secret');
  assert.equal(env.MAGCLAW_ZILLIZ_DATABASE, 'ai_social_memory');
  assert.equal(env.MAGCLAW_ZILLIZ_COLLECTION, 'magclaw_team_sharing_v1');
  assert.equal(env.MAGCLAW_RERANK_URL, 'https://rerank.example/v1/rerank');
  assert.equal(env.MAGCLAW_RERANK_API_KEY, 'rerank-secret');
  assert.equal(env.MAGCLAW_RERANK_MODEL, undefined);
  assert.equal(env.MAGCLAW_RERANK_CANDIDATE_K, '40');
  assert.equal(env.MAGCLAW_RERANK_TOP_N, '5');
  assert.equal(result.redacted.embedding.api_key, '[redacted]');
  assert.equal(result.redacted.zilliz.endpoint, '[redacted]');
  assert.equal(result.redacted.zilliz.token, '[redacted]');
  assert.equal(result.redacted.rerank.api_key, '[redacted]');
});

test('server yaml examples omit embedding preferred dimension by default', async () => {
  const serverExample = await readFile(new URL('../config/server.example.yaml', import.meta.url), 'utf8');
  const k8sExample = await readFile(new URL('../web/k8s/magclaw-web.yaml', import.meta.url), 'utf8');

  assert.doesNotMatch(serverExample, /preferred_dimension/);
  assert.doesNotMatch(k8sExample, /preferred_dimension/);
});
