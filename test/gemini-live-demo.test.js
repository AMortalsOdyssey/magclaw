import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  handleGeminiLiveDemoHttp,
  resolveCredentialsPath,
} from '../server/gemini-live-demo.js';

function makeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) {
        this.headers[String(name).toLowerCase()] = value;
      }
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    },
  };
}

function withEnv(patch, fn) {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('Gemini Live demo page uses mounted Vertex secret without sandboxing microphone access', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-gemini-live-'));
  try {
    const secretDir = path.join(tmp, 'vertex');
    await mkdir(secretDir);
    const credentialPath = path.join(secretDir, 'vertex.json');
    await writeFile(credentialPath, JSON.stringify({
      type: 'service_account',
      project_id: 'demo-project',
      private_key_id: 'demo',
      private_key: '-----BEGIN PRIVATE KEY-----\\nignored\\n-----END PRIVATE KEY-----\\n',
      client_email: 'demo@example.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    }));

    await withEnv({
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      MAGCLAW_VERTEX_SECRET_PATH: secretDir,
    }, async () => {
      assert.equal(resolveCredentialsPath(process.env), credentialPath);

      const res = makeResponse();
      const handled = await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        res,
        new URL('https://magclaw.example/s/demo/gemini-live'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      );
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /id="voiceSelect"/);
      assert.match(res.body, /id="promptInput"/);
      assert.match(res.body, /calculate_expression/);
      assert.match(res.body, /音频检测/);
      assert.equal(res.headers['permissions-policy'], 'microphone=(self)');
      assert.doesNotMatch(res.headers['content-security-policy'], /\bsandbox\b/);

      const status = makeResponse();
      assert.equal(await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        status,
        new URL('https://magclaw.example/api/gemini-live/status'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      ), true);
      assert.equal(status.statusCode, 200);
      const payload = JSON.parse(status.body);
      assert.equal(payload.credentialsConfigured, true);
      assert.equal(payload.projectConfigured, true);
      assert.equal(payload.voices, 30);
      assert.equal(payload.tools, 9);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
