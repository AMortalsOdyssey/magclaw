import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyServerYamlConfig } from '../server/config-yaml.js';

test('server yaml ignores runtime-scoped login data dir and fan-out settings', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-config-yaml-'));
  const configPath = path.join(tmp, 'server.yaml');
  const env = {};
  await writeFile(configPath, `
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
fanout_api:
  enabled: true
  base_url: "https://models.example/v1"
  model: "qwen-test"
  fallback_model: "deepseek-test"
  timeout_ms: 9000
  api_key: "secret"
`);

  const result = applyServerYamlConfig({ paths: [configPath], env });

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
  assert.equal(env.MAGCLAW_REQUIRE_LOGIN, undefined);
  assert.equal(env.MAGCLAW_DATA_DIR, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_ENABLED, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_BASE_URL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_KEY, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_MODEL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_API_FALLBACK_MODEL, undefined);
  assert.equal(env.MAGCLAW_FANOUT_TIMEOUT_MS, undefined);
});
