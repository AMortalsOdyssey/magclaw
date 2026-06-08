import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmbeddingClient,
  createRerankClient,
  createTeamSharingIndexingPipeline,
  createZillizTeamSharingClient,
} from '../server/team-sharing-clients.js';

function jsonResponse(data, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test('embedding client probes the real returned vector dimension without leaking credentials', async () => {
  const calls = [];
  const client = createEmbeddingClient({
    baseUrl: 'https://embedding.example/v1',
    apiKey: 'embedding-secret',
    model: 'qwen-embedding',
    preferredDimension: 1536,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    },
  });

  const probe = await client.probeDimension();

  assert.equal(probe.ok, true);
  assert.equal(probe.dimension, 3);
  assert.equal(calls[0].url, 'https://embedding.example/v1/embeddings');
  assert.equal(calls[0].body.model, 'qwen-embedding');
  assert.equal(calls[0].body.dimensions, 1536);
  assert.equal(calls[0].init.headers.authorization, 'Bearer embedding-secret');
  assert.doesNotMatch(JSON.stringify(probe), /embedding-secret/);
});

test('embedding client falls back to native dimension when provider rejects dimension override', async () => {
  const calls = [];
  const warnings = [];
  const client = createEmbeddingClient({
    baseUrl: 'https://embedding.example/v1',
    apiKey: 'embedding-secret',
    model: 'qwen-embedding',
    preferredDimension: 1536,
    warn: (...args) => warnings.push(args),
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return jsonResponse({
          error: 'Model does not support matryoshka representation, changing output dimensions will lead to poor results.',
        }, false, 400);
      }
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
    },
  });

  const probe = await client.probeDimension();

  assert.equal(probe.ok, true);
  assert.equal(probe.dimension, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.dimensions, 1536);
  assert.equal('dimensions' in calls[1].body, false);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(probe), /embedding-secret/);
});

test('rerank client normalizes provider scores by original candidate index', async () => {
  const calls = [];
  const client = createRerankClient({
    url: 'https://rerank.example/v1/rerank',
    apiKey: 'rerank-secret',
    model: 'bge-reranker',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, score: 0.33 },
        ],
      });
    },
  });

  const result = await client.rerank({
    query: 'rerank 反馈',
    candidates: [
      { title: 'A', text: '普通内容' },
      { title: 'B', text: 'rerank 反馈 hotness' },
    ],
    limit: 2,
  });

  assert.deepEqual(result, [
    { index: 1, score: 0.91 },
    { index: 0, score: 0.33 },
  ]);
  assert.equal(calls[0].url, 'https://rerank.example/v1/rerank');
  assert.equal(calls[0].body.query, 'rerank 反馈');
  assert.deepEqual(calls[0].body.documents, ['A\n普通内容', 'B\nrerank 反馈 hotness']);
  assert.equal(calls[0].body.top_n, 2);
  assert.equal(calls[0].init.headers.authorization, 'Bearer rerank-secret');
});

test('zilliz client searches and upserts team-sharing vector documents with scoped filters', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    dimension: 3,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/entities/search')) {
        return jsonResponse({
          data: [
            [
              {
                vector_document_id: 'doc_1',
                workspace_id: 'ws_team',
                channel_id: 'chan_team',
                project_key: 'magclaw',
                session_id: 'sess_1',
                uploader_id: 'hum_jhb',
                uploader_name: '蒋海波',
                uploader_email: 'jhb@example.com',
                uploader_search_text: 'hum_jhb 蒋海波 jhb@example.com',
                topic_id: 'rerank-feedback',
                layer: 'L1',
                title: 'Rerank feedback',
                text: 'Zilliz -> rerank -> top5',
                source_ref: 'sess_1/topics/rerank-feedback.md#evt_1',
                updated_at: '2026-06-01T12:00:00.000Z',
                distance: 0.82,
              },
            ],
          ],
        });
      }
      return jsonResponse({ data: { upsertCount: 1 } });
    },
  });

  const search = await client.search({
    queryVector: [0.1, 0.2, 0.3],
    channelId: 'chan_team',
    projectKey: 'magclaw',
    uploaderIds: ['hum_jhb', 'hum_zhang'],
    dateRange: {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    },
    limit: 40,
  });
  const upsert = await client.upsertDocuments({
    documents: [
      {
        vectorDocumentId: 'doc_1',
        workspaceId: 'ws_team',
        channelId: 'chan_team',
        projectKey: 'magclaw',
        sessionId: 'sess_1',
        uploaderId: 'hum_jhb',
        uploaderName: '蒋海波',
        uploaderEmail: 'jhb@example.com',
        uploaderSearchText: 'hum_jhb 蒋海波 jhb@example.com',
        topicId: 'rerank-feedback',
        layer: 'L1',
        title: 'Rerank feedback',
        text: 'Zilliz -> rerank -> top5',
        sourceRef: 'sess_1#evt_1',
        updatedAt: '2026-06-01T12:00:00.000Z',
      },
    ],
    embeddings: [[0.1, 0.2, 0.3]],
  });

  assert.equal(search.ok, true);
  assert.equal(search.candidates[0].vectorDocumentId, 'doc_1');
  assert.equal(search.candidates[0].uploaderName, '蒋海波');
  assert.equal(search.candidates[0].vectorScore, 0.82);
  assert.match(calls[0].url, /\/v2\/vectordb\/entities\/search$/);
  assert.equal(calls[0].body.dbName, 'ai_social_memory');
  assert.equal(calls[0].body.collectionName, 'magclaw_team_sharing_v1');
  assert.ok(calls[0].body.outputFields.includes('uploader_name'));
  assert.match(calls[0].body.filter, /channel_id == "chan_team"/);
  assert.match(calls[0].body.filter, /project_key == "magclaw"/);
  assert.match(calls[0].body.filter, /\(uploader_id == "hum_jhb" \|\| uploader_id == "hum_zhang"\)/);
  assert.match(calls[0].body.filter, /updated_at >= "2026-06-01T00:00:00.000Z"/);
  assert.match(calls[0].body.filter, /updated_at <= "2026-06-02T00:00:00.000Z"/);
  assert.equal(upsert.ok, true);
  assert.match(calls[1].url, /\/v2\/vectordb\/entities\/upsert$/);
  assert.equal(calls[1].body.data[0].vector.length, 3);
  assert.equal(calls[1].body.data[0].uploader_id, 'hum_jhb');
  assert.equal(calls[1].body.data[0].uploader_name, '蒋海波');
  assert.equal(calls[1].body.data[0].uploader_email, 'jhb@example.com');
  assert.equal(calls[1].init.headers.authorization, 'Bearer zilliz-secret');
});

test('zilliz client runs BM25 keyword search by default', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({
        data: [[{
          entity: {
            vector_document_id: 'doc_keyword',
            workspace_id: 'ws_team',
            channel_id: 'chan_team',
            project_key: 'magclaw',
            session_id: 'sess_keyword',
            uploader_id: 'hum_jhb',
            uploader_name: '蒋海波',
            topic_id: 'session-sync-hooks',
            layer: 'L1',
            title: 'Session sync hooks',
            text: 'rawEventId anchorEventId',
            source_ref: 'sess_keyword/topics/session-sync-hooks.md#evt_1',
            updated_at: '2026-06-01T12:00:00.000Z',
          },
          score: 0.76,
        }]],
      });
    },
  });

  const search = await client.keywordSearch({
    query: 'rawEventId anchorEventId',
    workspaceId: 'ws_team',
    channelId: 'chan_team',
    projectKey: 'magclaw',
    uploaderIds: ['hum_jhb'],
    limit: 20,
  });

  assert.equal(search.ok, true);
  assert.equal(search.candidates[0].vectorDocumentId, 'doc_keyword');
  assert.equal(search.candidates[0].keywordScore, 0.76);
  assert.equal(search.candidates[0].vectorScore, 0.05);
  assert.equal(calls[0].body.annsField, 'sparse');
  assert.equal(calls[0].body.metricType, 'BM25');
  assert.deepEqual(calls[0].body.data, ['rawEventId anchorEventId']);
  assert.match(calls[0].body.filter, /workspace_id == "ws_team"/);
  assert.match(calls[0].body.filter, /uploader_id == "hum_jhb"/);
});

test('zilliz client runs multiple BM25 keyword queries and fuses results', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      const keyword = body.data[0];
      const id = keyword === 'BM25' ? 'doc_bm25' : keyword === 'SessionSyncHooks' ? 'doc_hooks' : 'doc_long';
      return jsonResponse({
        data: [[{
          entity: {
            vector_document_id: id,
            workspace_id: 'ws_team',
            channel_id: 'chan_team',
            project_key: 'magclaw',
            session_id: 'sess_keyword',
            topic_id: id,
            layer: 'L1',
            title: id,
            text: keyword,
            source_ref: `sess_keyword/topics/${id}.md#evt_1`,
            updated_at: '2026-06-01T12:00:00.000Z',
          },
          score: keyword === 'BM25' ? 0.91 : 0.72,
        }]],
      });
    },
  });

  const search = await client.keywordSearch({
    query: 'team leader wants a synthesis',
    keywords: ['BM25', 'SessionSyncHooks'],
    workspaceId: 'ws_team',
    limit: 20,
  });

  assert.equal(search.ok, true);
  assert.deepEqual(search.queries, ['BM25', 'SessionSyncHooks', 'team leader wants a synthesis']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.body.data[0]), search.queries);
  assert.deepEqual(search.candidates.map((item) => item.vectorDocumentId).sort(), ['doc_bm25', 'doc_hooks', 'doc_long']);
  assert.ok(search.candidates.find((item) => item.vectorDocumentId === 'doc_bm25').keywordScore >= 0.91);
});

test('zilliz client creates collection with detected native embedding dimension', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({ code: 100, message: 'collection not found' }, false, 404);
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  const result = await client.ensureCollection({ dimension: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.existed, false);
  assert.equal(result.dimension, 4);
  assert.match(calls[1].url, /\/v2\/vectordb\/collections\/create$/);
  const vectorField = calls[1].body.schema.fields.find((field) => field.fieldName === 'vector');
  const sparseField = calls[1].body.schema.fields.find((field) => field.fieldName === 'sparse');
  assert.equal(vectorField.elementTypeParams.dim, 4);
  assert.equal(sparseField.dataType, 'SparseFloatVector');
  assert.deepEqual(calls[1].body.schema.fields.find((field) => field.fieldName === 'text').elementTypeParams.analyzer_params, {
    tokenizer: 'jieba',
    filter: ['lowercase', 'cnalphanumonly'],
  });
  assert.equal(calls[1].body.schema.functions[0].type, 'BM25');
  assert.match(calls[2].url, /\/v2\/vectordb\/indexes\/create$/);
  assert.equal(calls[2].body.indexParams[0].fieldName, 'vector');
  assert.equal(calls[2].body.indexParams[0].metricType, 'COSINE');
  assert.equal(calls[2].body.indexParams[0].indexConfig.index_type, 'AUTOINDEX');
  assert.equal(calls[3].body.indexParams[0].fieldName, 'sparse');
  assert.equal(calls[3].body.indexParams[0].metricType, 'BM25');
  assert.match(calls[4].url, /\/v2\/vectordb\/collections\/get_load_state$/);
  assert.match(calls[5].url, /\/v2\/vectordb\/collections\/load$/);
});

test('zilliz client creates BM25 schema and sparse index for new collections by default', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v2',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({ code: 100, message: 'collection not found' }, false, 404);
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  const result = await client.ensureCollection({ dimension: 3 });
  const createBody = calls.find((call) => String(call.url).endsWith('/collections/create')).body;
  const textField = createBody.schema.fields.find((field) => field.fieldName === 'text');
  const uploaderIdField = createBody.schema.fields.find((field) => field.fieldName === 'uploader_id');
  const uploaderNameField = createBody.schema.fields.find((field) => field.fieldName === 'uploader_name');
  const uploaderSearchTextField = createBody.schema.fields.find((field) => field.fieldName === 'uploader_search_text');
  const sparseField = createBody.schema.fields.find((field) => field.fieldName === 'sparse');
  const sparseIndex = calls.find((call) => String(call.url).endsWith('/indexes/create') && call.body.indexParams[0].fieldName === 'sparse');

  assert.equal(result.ok, true);
  assert.equal(textField.elementTypeParams.enable_analyzer, true);
  assert.deepEqual(textField.elementTypeParams.analyzer_params, {
    tokenizer: 'jieba',
    filter: ['lowercase', 'cnalphanumonly'],
  });
  assert.equal(sparseField.dataType, 'SparseFloatVector');
  assert.equal(uploaderIdField.dataType, 'VarChar');
  assert.equal(uploaderNameField.dataType, 'VarChar');
  assert.equal(uploaderSearchTextField.dataType, 'VarChar');
  assert.equal(createBody.schema.functions[0].type, 'BM25');
  assert.equal(createBody.schema.functions[0].outputFieldNames[0], 'sparse');
  assert.equal(sparseIndex.body.indexParams[0].metricType, 'BM25');
});

test('zilliz client recreates when cloud reports cannot find collection', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({
          code: 100,
          message: "can't find collection[database=ai_social_memory][collection=magclaw_team_sharing_v1]",
        });
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  const result = await client.ensureCollection({ dimension: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.existed, false);
  assert.ok(calls.some((call) => String(call.url).endsWith('/collections/create')));
});

test('zilliz client rejects existing BM25-incompatible collection unless recreate is enabled', async () => {
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url) => {
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({
          code: 0,
          data: {
            schema: {
              fields: [
                { fieldName: 'text', dataType: 'VarChar', elementTypeParams: { max_length: 32766 } },
                { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: 3 } },
              ],
              functions: [],
            },
          },
        });
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  await assert.rejects(
    () => client.ensureCollection({ dimension: 3 }),
    /missing BM25 support.*default BM25 schema/,
  );
});

test('zilliz client can recreate existing collection to add BM25 support when enabled', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    recreateForBm25: true,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({
          code: 0,
          data: {
            schema: {
              fields: [
                { fieldName: 'text', dataType: 'VarChar', elementTypeParams: { max_length: 32766 } },
                { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: 3 } },
              ],
              functions: [],
            },
          },
        });
      }
      if (String(url).endsWith('/collections/get_load_state')) {
        return jsonResponse({ code: 0, data: { loadState: 'LoadStateLoaded' } });
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  const result = await client.ensureCollection({ dimension: 3 });
  const paths = calls.map((call) => call.url.replace('https://zilliz.example', ''));
  const createBody = calls.find((call) => String(call.url).endsWith('/collections/create')).body;

  assert.equal(result.ok, true);
  assert.equal(result.recreatedForBm25, true);
  assert.equal(result.bm25.ok, true);
  assert.ok(paths.indexOf('/v2/vectordb/collections/drop') < paths.indexOf('/v2/vectordb/collections/create'));
  assert.equal(createBody.schema.fields.find((field) => field.fieldName === 'sparse').dataType, 'SparseFloatVector');
  assert.deepEqual(createBody.schema.fields.find((field) => field.fieldName === 'text').elementTypeParams.analyzer_params, {
    tokenizer: 'jieba',
    filter: ['lowercase', 'cnalphanumonly'],
  });
  assert.equal(createBody.schema.functions[0].type, 'BM25');
});

test('zilliz client ensures existing collection has a vector index and is loaded', async () => {
  const calls = [];
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/collections/describe')) {
        return jsonResponse({
          code: 0,
          data: {
            schema: {
              fields: [
                {
                  fieldName: 'text',
                  dataType: 'VarChar',
                  elementTypeParams: {
                    max_length: 32766,
                    enable_analyzer: true,
                    analyzer_params: { tokenizer: 'jieba', filter: ['lowercase', 'cnalphanumonly'] },
                  },
                },
                { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: 4096 } },
                { fieldName: 'sparse', dataType: 'SparseFloatVector' },
              ],
              functions: [{ name: 'text_bm25_emb', type: 1, inputFieldNames: ['text'], outputFieldNames: ['sparse'] }],
            },
          },
        });
      }
      if (String(url).endsWith('/collections/get_load_state')) {
        return jsonResponse({ code: 0, data: { loadState: 'LoadStateNotLoaded' } });
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });

  const result = await client.ensureCollection({ dimension: 4096 });

  assert.equal(result.ok, true);
  assert.equal(result.existed, true);
  assert.equal(result.dimension, 4096);
  assert.deepEqual(calls.map((call) => call.url.replace('https://zilliz.example', '')), [
    '/v2/vectordb/collections/describe',
    '/v2/vectordb/indexes/create',
    '/v2/vectordb/indexes/create',
    '/v2/vectordb/collections/get_load_state',
    '/v2/vectordb/collections/load',
  ]);
});

test('zilliz client treats REST code errors as failures even when HTTP succeeds', async () => {
  const client = createZillizTeamSharingClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_sharing_v1',
    fetch: async () => jsonResponse({ code: 101, message: 'collection not loaded' }),
  });

  await assert.rejects(
    () => client.search({ queryVector: [0.1, 0.2, 0.3], limit: 5 }),
    /collection not loaded/,
  );
});

test('team sharing indexing pipeline embeds abstract text before zilliz upsert', async () => {
  const embedded = [];
  const upserts = [];
  const ensured = [];
  const pipeline = createTeamSharingIndexingPipeline({
    embeddingClient: {
      embed: async (text) => {
        embedded.push(text);
        return { ok: true, embedding: [0.1, 0.2, 0.3] };
      },
    },
    zillizClient: {
      ensureCollection: async (payload) => {
        ensured.push(payload);
        return { ok: true, existed: true, dimension: payload.dimension };
      },
      upsertDocuments: async (payload) => {
        upserts.push(payload);
        return { ok: true, count: payload.documents.length };
      },
    },
  });

  const result = await pipeline.indexDocuments({
    documents: [
      {
        vectorDocumentId: 'sess_1:L0',
        layer: 'L0',
        title: 'Team sharing',
        text: 'L0 abstract for retrieval',
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(embedded, ['Team sharing\nL0 abstract for retrieval']);
  assert.deepEqual(ensured, [{ dimension: 3 }]);
  assert.equal(upserts[0].embeddings[0].length, 3);
});
