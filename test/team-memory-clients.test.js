import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmbeddingClient,
  createRerankClient,
  createTeamMemoryIndexingPipeline,
  createZillizTeamMemoryClient,
} from '../server/team-memory-clients.js';

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

test('zilliz client searches and upserts team-memory vector documents with scoped filters', async () => {
  const calls = [];
  const client = createZillizTeamMemoryClient({
    endpoint: 'https://zilliz.example',
    token: 'zilliz-secret',
    database: 'ai_social_memory',
    collection: 'magclaw_team_memory_v1',
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
                topic_id: 'rerank-feedback',
                layer: 'L1',
                title: 'Rerank feedback',
                text: 'Zilliz -> rerank -> top5',
                source_ref: 'sess_1/topics/rerank-feedback/overview.md#evt_1',
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
  assert.equal(search.candidates[0].vectorScore, 0.82);
  assert.match(calls[0].url, /\/v2\/vectordb\/entities\/search$/);
  assert.equal(calls[0].body.dbName, 'ai_social_memory');
  assert.equal(calls[0].body.collectionName, 'magclaw_team_memory_v1');
  assert.match(calls[0].body.filter, /channel_id == "chan_team"/);
  assert.match(calls[0].body.filter, /project_key == "magclaw"/);
  assert.match(calls[0].body.filter, /updated_at >= "2026-06-01T00:00:00.000Z"/);
  assert.match(calls[0].body.filter, /updated_at <= "2026-06-02T00:00:00.000Z"/);
  assert.equal(upsert.ok, true);
  assert.match(calls[1].url, /\/v2\/vectordb\/entities\/upsert$/);
  assert.equal(calls[1].body.data[0].vector.length, 3);
  assert.equal(calls[1].init.headers.authorization, 'Bearer zilliz-secret');
});

test('team memory indexing pipeline embeds abstract text before zilliz upsert', async () => {
  const embedded = [];
  const upserts = [];
  const pipeline = createTeamMemoryIndexingPipeline({
    embeddingClient: {
      embed: async (text) => {
        embedded.push(text);
        return { ok: true, embedding: [0.1, 0.2, 0.3] };
      },
    },
    zillizClient: {
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
        title: 'Team memory',
        text: 'L0 abstract for retrieval',
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(embedded, ['Team memory\nL0 abstract for retrieval']);
  assert.equal(upserts[0].embeddings[0].length, 3);
});
