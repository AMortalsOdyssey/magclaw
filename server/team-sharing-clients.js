function trimSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

async function readJsonResponse(response) {
  const data = await response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return text ? { error: text } : {};
  });
  if (!response.ok) {
    const message = data?.error?.message || data?.error || data?.message || `${response.status} ${response.statusText}`;
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }
  return data;
}

function authorizationHeaders(secret = '') {
  const clean = String(secret || '').trim();
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(clean ? { authorization: `Bearer ${clean}` } : {}),
  };
}

function normalizeEmbedding(data) {
  const embedding = data?.data?.[0]?.embedding || data?.embedding || data?.embeddings?.[0] || [];
  return asArray(embedding).map(Number).filter((value) => Number.isFinite(value));
}

export function createEmbeddingClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = trimSlash(options.baseUrl || process.env.MAGCLAW_EMBEDDING_BASE_URL || '');
  const apiKey = options.apiKey || process.env.MAGCLAW_EMBEDDING_API_KEY || '';
  const model = options.model || process.env.MAGCLAW_EMBEDDING_MODEL || '';
  const preferredDimension = Number(options.preferredDimension || process.env.MAGCLAW_EMBEDDING_PREFERRED_DIMENSION || 0);
  async function embed(input) {
    if (!baseUrl) throw new Error('Embedding base URL is not configured.');
    const body = {
      model,
      input,
      ...(preferredDimension ? { dimensions: preferredDimension } : {}),
    };
    const response = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: authorizationHeaders(apiKey),
      body: JSON.stringify(body),
    });
    return normalizeEmbedding(await readJsonResponse(response));
  }
  return {
    async embed(input) {
      const embedding = await embed(input);
      return { ok: true, embedding, dimension: embedding.length };
    },
    async probeDimension() {
      const embedding = await embed('dimension probe');
      return { ok: true, dimension: embedding.length };
    },
  };
}

function candidateDocumentText(candidate = {}) {
  return [candidate.title, candidate.topicId, candidate.text || candidate.evidence || candidate.conclusion]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

function normalizeRerankResults(data) {
  const raw = asArray(data?.results || data?.data?.results || data?.data || data?.rerank_results);
  return raw
    .map((item) => ({
      index: Number(item.index ?? item.document_index ?? item.id),
      score: clamp01(item.relevance_score ?? item.score ?? item.value),
    }))
    .filter((item) => Number.isInteger(item.index));
}

export function createRerankClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const url = String(options.url || process.env.MAGCLAW_RERANK_URL || '').trim();
  const apiKey = options.apiKey || process.env.MAGCLAW_RERANK_API_KEY || '';
  const model = options.model || process.env.MAGCLAW_RERANK_MODEL || '';
  return {
    async rerank({ query = '', candidates = [], limit = 5 } = {}) {
      if (!url || !asArray(candidates).length) return [];
      const body = {
        ...(model ? { model } : {}),
        query,
        documents: asArray(candidates).map(candidateDocumentText),
        top_n: Math.max(1, Number(limit || candidates.length)),
      };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: authorizationHeaders(apiKey),
        body: JSON.stringify(body),
      });
      return normalizeRerankResults(await readJsonResponse(response));
    },
  };
}

function zillizFilterValue(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function dateBound(dateRange = {}, keys = []) {
  for (const key of keys) {
    const value = dateRange?.[key];
    if (value) return String(value);
  }
  return '';
}

function buildZillizFilter({ workspaceId = '', channelId = '', projectKey = '', sessionId = '', layer = '', dateRange = null } = {}) {
  const range = dateRange && typeof dateRange === 'object' ? dateRange : {};
  const from = dateBound(range, ['from', 'start', 'since', 'updatedAfter', 'updated_after']);
  const to = dateBound(range, ['to', 'end', 'until', 'updatedBefore', 'updated_before']);
  return [
    workspaceId ? `workspace_id == "${zillizFilterValue(workspaceId)}"` : '',
    channelId ? `channel_id == "${zillizFilterValue(channelId)}"` : '',
    projectKey ? `project_key == "${zillizFilterValue(projectKey)}"` : '',
    sessionId ? `session_id == "${zillizFilterValue(sessionId)}"` : '',
    layer ? `layer == "${zillizFilterValue(layer)}"` : '',
    from ? `updated_at >= "${zillizFilterValue(from)}"` : '',
    to ? `updated_at <= "${zillizFilterValue(to)}"` : '',
  ].filter(Boolean).join(' && ');
}

function flattenZillizRows(data) {
  const rows = data?.data || data?.results || [];
  if (Array.isArray(rows[0])) return rows[0];
  return asArray(rows);
}

function zillizCandidate(row = {}) {
  const entity = row.entity && typeof row.entity === 'object' ? row.entity : row;
  return {
    vectorDocumentId: String(entity.vector_document_id || entity.vectorDocumentId || entity.id || entity._id || ''),
    workspaceId: String(entity.workspace_id || entity.workspaceId || ''),
    channelId: String(entity.channel_id || entity.channelId || ''),
    projectKey: String(entity.project_key || entity.projectKey || ''),
    runtime: String(entity.runtime || ''),
    sessionId: String(entity.session_id || entity.sessionId || ''),
    topicId: String(entity.topic_id || entity.topicId || ''),
    layer: String(entity.layer || ''),
    title: String(entity.title || ''),
    text: String(entity.text || ''),
    sourceRef: String(entity.source_ref || entity.sourceRef || ''),
    updatedAt: String(entity.updated_at || entity.updatedAt || ''),
    vectorScore: clamp01(row.distance ?? row.score ?? entity.score),
    keywordScore: 0,
    freshnessScore: 0.5,
  };
}

function documentEntity(document = {}, embedding = []) {
  return {
    _id: String(document.vectorDocumentId || document.id || ''),
    vector_document_id: String(document.vectorDocumentId || document.id || ''),
    workspace_id: String(document.workspaceId || ''),
    channel_id: String(document.channelId || ''),
    project_key: String(document.projectKey || ''),
    runtime: String(document.runtime || ''),
    session_id: String(document.sessionId || ''),
    topic_id: String(document.topicId || ''),
    layer: String(document.layer || ''),
    title: String(document.title || ''),
    text: String(document.text || ''),
    source_ref: String(document.sourceRef || ''),
    updated_at: String(document.updatedAt || new Date().toISOString()),
    hotness: Number(document.hotness || 0),
    vector: embedding,
  };
}

export function createZillizTeamSharingClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const endpoint = trimSlash(options.endpoint || process.env.MAGCLAW_ZILLIZ_ENDPOINT || '');
  const token = options.token || process.env.MAGCLAW_ZILLIZ_TOKEN || '';
  const database = options.database || process.env.MAGCLAW_ZILLIZ_DATABASE || 'default';
  const collection = options.collection || process.env.MAGCLAW_ZILLIZ_COLLECTION || 'magclaw_team_sharing_v1';
  const dimension = Number(options.dimension || process.env.MAGCLAW_EMBEDDING_DIMENSION || process.env.MAGCLAW_EMBEDDING_PREFERRED_DIMENSION || 1536);
  const headers = authorizationHeaders(token);
  function endpointUrl(pathname) {
    if (!endpoint) throw new Error('Zilliz endpoint is not configured.');
    return `${endpoint}${pathname}`;
  }
  return {
    async search({ queryVector = [], workspaceId = '', channelId = '', projectKey = '', sessionId = '', layer = '', dateRange = null, limit = 40 } = {}) {
      const filter = buildZillizFilter({ workspaceId, channelId, projectKey, sessionId, layer, dateRange });
      const response = await fetchImpl(endpointUrl('/v2/vectordb/entities/search'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dbName: database,
          collectionName: collection,
          data: [queryVector],
          annsField: 'vector',
          limit,
          outputFields: [
            'vector_document_id',
            'workspace_id',
            'channel_id',
            'project_key',
            'runtime',
            'session_id',
            'topic_id',
            'layer',
            'title',
            'text',
            'source_ref',
            'updated_at',
            'hotness',
          ],
          ...(filter ? { filter } : {}),
        }),
      });
      const data = await readJsonResponse(response);
      return {
        ok: true,
        candidates: flattenZillizRows(data).map(zillizCandidate).filter((item) => item.vectorDocumentId),
      };
    },
    async upsertDocuments({ documents = [], embeddings = [] } = {}) {
      const data = asArray(documents).map((document, index) => documentEntity(document, embeddings[index] || document.vector || []));
      if (!data.length) return { ok: true, count: 0 };
      const response = await fetchImpl(endpointUrl('/v2/vectordb/entities/upsert'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dbName: database,
          collectionName: collection,
          data,
        }),
      });
      const result = await readJsonResponse(response);
      return {
        ok: true,
        count: Number(result?.data?.upsertCount || result?.data?.insertCount || data.length),
      };
    },
    async ensureCollection() {
      const describe = await fetchImpl(endpointUrl('/v2/vectordb/collections/describe'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ dbName: database, collectionName: collection }),
      });
      const described = await describe.json().catch(() => ({}));
      if (describe.ok && Number(described?.code || 0) === 0) return { ok: true, existed: true, dimension };
      const create = await fetchImpl(endpointUrl('/v2/vectordb/collections/create'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dbName: database,
          collectionName: collection,
          schema: {
            autoID: false,
            enableDynamicField: true,
            fields: [
              { fieldName: '_id', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: 512 } },
              { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: dimension } },
              { fieldName: 'vector_document_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
              { fieldName: 'workspace_id', dataType: 'VarChar', elementTypeParams: { max_length: 256 } },
              { fieldName: 'channel_id', dataType: 'VarChar', elementTypeParams: { max_length: 256 } },
              { fieldName: 'project_key', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
              { fieldName: 'session_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
              { fieldName: 'topic_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
              { fieldName: 'layer', dataType: 'VarChar', elementTypeParams: { max_length: 32 } },
              { fieldName: 'title', dataType: 'VarChar', elementTypeParams: { max_length: 4096 } },
              { fieldName: 'text', dataType: 'VarChar', elementTypeParams: { max_length: 32766 } },
              { fieldName: 'source_ref', dataType: 'VarChar', elementTypeParams: { max_length: 4096 } },
              { fieldName: 'updated_at', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
              { fieldName: 'hotness', dataType: 'Double' },
            ],
          },
        }),
      });
      await readJsonResponse(create);
      return { ok: true, existed: false, dimension };
    },
  };
}

function textForEmbedding(document = {}) {
  return [document.title, document.topicId, document.text]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

export function createTeamSharingIndexingPipeline(options = {}) {
  const embeddingClient = options.embeddingClient || createEmbeddingClient(options.embedding || {});
  const zillizClient = options.zillizClient || createZillizTeamSharingClient(options.zilliz || {});
  return {
    async indexDocuments({ documents = [] } = {}) {
      const activeDocuments = asArray(documents).filter((doc) => doc?.active !== false && doc?.vectorDocumentId);
      if (!activeDocuments.length) return { ok: true, count: 0 };
      const embeddings = [];
      for (const document of activeDocuments) {
        const result = await embeddingClient.embed(textForEmbedding(document));
        embeddings.push(result.embedding || result.embeddings || []);
      }
      const upsert = await zillizClient.upsertDocuments({ documents: activeDocuments, embeddings });
      return {
        ok: true,
        count: Number(upsert?.count || activeDocuments.length),
      };
    },
  };
}
