function trimSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const DEFAULT_BM25_FIELD = 'sparse';
const DEFAULT_BM25_TEXT_FIELD = 'text';
const DEFAULT_BM25_FUNCTION_NAME = 'text_bm25_emb';
const DEFAULT_BM25_ANALYZER_FILTERS = ['lowercase', 'cnalphanumonly'];

function defaultBm25AnalyzerParams() {
  return {
    tokenizer: 'jieba',
    filter: [...DEFAULT_BM25_ANALYZER_FILTERS],
  };
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeTextList(value = []) {
  const values = Array.isArray(value) ? value : [value];
  const items = [];
  for (const item of values) {
    if (item === undefined || item === null || item === false || item === true) continue;
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items.push(...normalizeTextList(parsed));
          continue;
        }
      } catch {}
    }
    items.push(...text.split(/[\n,，、;；|]+/g).map((part) => part.trim()).filter(Boolean));
  }
  return items;
}

function uniqueTextList(values = [], limit = 12) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

async function readJsonResponse(response) {
  const data = await response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return text ? { error: text } : {};
  });
  const apiCode = data?.code;
  const apiFailed = apiCode !== undefined && apiCode !== null && Number(apiCode) !== 0;
  if (!response.ok || apiFailed) {
    const message = data?.error?.message || data?.error || data?.message || `${response.status} ${response.statusText}`;
    const error = new Error(String(message));
    error.status = response.status;
    if (apiFailed) error.code = apiCode;
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

function objectFromJsonish(value) {
  if (!value || typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function appendFieldParams(params, source) {
  if (!source) return;
  if (Array.isArray(source)) {
    for (const item of source) {
      const key = String(item?.key || item?.name || '').trim();
      if (!key) continue;
      params[key] = objectFromJsonish(item.value);
    }
    return;
  }
  if (typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    params[key] = objectFromJsonish(value);
  }
}

function fieldParams(field = {}) {
  const params = {};
  appendFieldParams(params, field.typeParams);
  appendFieldParams(params, field.type_params);
  appendFieldParams(params, field.elementTypeParams);
  appendFieldParams(params, field.element_type_params);
  appendFieldParams(params, field.params);
  return params;
}

function truthyParam(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function analyzerParamsMatch(value) {
  const params = objectFromJsonish(value);
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const tokenizer = String(params.tokenizer || params.type || '').toLowerCase();
    const filters = asArray(params.filter || params.filters)
      .map((item) => String(item).toLowerCase());
    return tokenizer === 'jieba'
      && DEFAULT_BM25_ANALYZER_FILTERS.every((filter) => filters.includes(filter));
  }
  const serialized = JSON.stringify(params || '').toLowerCase();
  return serialized.includes('jieba')
    && DEFAULT_BM25_ANALYZER_FILTERS.every((filter) => serialized.includes(filter));
}

function normalizeEmbedding(data) {
  const embedding = data?.data?.[0]?.embedding || data?.embedding || data?.embeddings?.[0] || [];
  return asArray(embedding).map(Number).filter((value) => Number.isFinite(value));
}

function providerRejectsEmbeddingDimension(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return Boolean(message && (
    message.includes('matryoshka')
    || message.includes('output dimensions')
    || message.includes('dimensions')
    || message.includes('dimension')
  ));
}

export function createEmbeddingClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = trimSlash(options.baseUrl || process.env.MAGCLAW_EMBEDDING_BASE_URL || '');
  const apiKey = options.apiKey || process.env.MAGCLAW_EMBEDDING_API_KEY || '';
  const model = options.model || process.env.MAGCLAW_EMBEDDING_MODEL || '';
  const preferredDimension = Number(options.preferredDimension || process.env.MAGCLAW_EMBEDDING_PREFERRED_DIMENSION || 0);
  const warn = typeof options.warn === 'function' ? options.warn : console.warn;
  async function requestEmbedding(input, dimension = preferredDimension) {
    if (!baseUrl) throw new Error('Embedding base URL is not configured.');
    const body = {
      model,
      input,
      ...(dimension ? { dimensions: dimension } : {}),
    };
    const response = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: authorizationHeaders(apiKey),
      body: JSON.stringify(body),
    });
    return normalizeEmbedding(await readJsonResponse(response));
  }
  async function embed(input) {
    try {
      return await requestEmbedding(input);
    } catch (error) {
      if (!preferredDimension || !providerRejectsEmbeddingDimension(error)) throw error;
      warn('[team-sharing] embedding preferred dimension unsupported; retrying with provider native dimension', {
        model,
        preferredDimension,
        error: String(error?.message || error).slice(0, 160),
      });
      return requestEmbedding(input, 0);
    }
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

function zillizOrEquals(fieldName = '', values = []) {
  const unique = [...new Set(normalizeTextList(values))];
  if (!fieldName || !unique.length) return '';
  const clauses = unique.map((value) => `${fieldName} == "${zillizFilterValue(value)}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' || ')})`;
}

function buildZillizFilter({ workspaceId = '', channelId = '', projectKey = '', sessionId = '', layer = '', sourceKind = '', uploaderIds = [], dateRange = null } = {}) {
  const range = dateRange && typeof dateRange === 'object' ? dateRange : {};
  const from = dateBound(range, ['from', 'start', 'since', 'updatedAfter', 'updated_after']);
  const to = dateBound(range, ['to', 'end', 'until', 'updatedBefore', 'updated_before']);
  return [
    workspaceId ? `workspace_id == "${zillizFilterValue(workspaceId)}"` : '',
    channelId ? `channel_id == "${zillizFilterValue(channelId)}"` : '',
    projectKey ? `project_key == "${zillizFilterValue(projectKey)}"` : '',
    sessionId ? `session_id == "${zillizFilterValue(sessionId)}"` : '',
    layer ? `layer == "${zillizFilterValue(layer)}"` : '',
    sourceKind ? `source_kind == "${zillizFilterValue(sourceKind)}"` : '',
    zillizOrEquals('uploader_id', uploaderIds),
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
    sourceKind: String(entity.source_kind || entity.sourceKind || ''),
    workspaceId: String(entity.workspace_id || entity.workspaceId || ''),
    channelId: String(entity.channel_id || entity.channelId || ''),
    projectKey: String(entity.project_key || entity.projectKey || ''),
    runtime: String(entity.runtime || ''),
    sessionId: String(entity.session_id || entity.sessionId || ''),
    shareId: String(entity.share_id || entity.shareId || ''),
    shareSectionId: String(entity.share_section_id || entity.shareSectionId || ''),
    contentType: String(entity.content_type || entity.contentType || ''),
    uploaderId: String(entity.uploader_id || entity.uploaderId || ''),
    uploaderName: String(entity.uploader_name || entity.uploaderName || ''),
    uploaderEmail: String(entity.uploader_email || entity.uploaderEmail || ''),
    uploaderAvatar: String(entity.uploader_avatar || entity.uploaderAvatar || ''),
    uploaderSearchText: String(entity.uploader_search_text || entity.uploaderSearchText || ''),
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

function zillizKeywordCandidate(row = {}, index = 0) {
  const candidate = zillizCandidate(row);
  const rawScore = Number(row.distance ?? row.score ?? row.entity?.score ?? 0);
  return {
    ...candidate,
    vectorScore: 0.05,
    keywordScore: Number.isFinite(rawScore) && rawScore > 0 ? clamp01(rawScore) : 1 / (index + 1),
  };
}

function zillizKeywordQueries({ query = '', keywordQuery = '', keywords = [], topics = [] } = {}) {
  return uniqueTextList([
    ...normalizeTextList(keywords),
    ...normalizeTextList(topics),
    ...normalizeTextList(keywordQuery),
    query,
  ], 12);
}

function fuseZillizKeywordCandidates(candidateGroups = [], limit = 40, rrfK = 30) {
  const byId = new Map();
  asArray(candidateGroups).forEach((group, groupIndex) => {
    asArray(group).forEach((candidate, index) => {
      const id = String(candidate?.vectorDocumentId || '').trim();
      if (!id) return;
      const existing = byId.get(id) || {
        ...candidate,
        keywordScore: 0,
        vectorScore: 0.05,
        keywordRrfScore: 0,
        keywordQueries: [],
      };
      const score = clamp01(candidate.keywordScore ?? candidate.score);
      existing.keywordScore = Math.max(existing.keywordScore, score);
      existing.keywordRrfScore += 1 / (rrfK + index + 1);
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? 0.05));
      existing.keywordQueries.push(groupIndex);
      byId.set(id, {
        ...existing,
        ...candidate,
        keywordScore: existing.keywordScore,
        keywordRrfScore: existing.keywordRrfScore,
        keywordQueries: existing.keywordQueries,
        vectorScore: existing.vectorScore,
      });
    });
  });
  return [...byId.values()]
    .sort((left, right) => right.keywordRrfScore - left.keywordRrfScore || right.keywordScore - left.keywordScore)
    .slice(0, limit);
}

function documentEntity(document = {}, embedding = []) {
  return {
    _id: String(document.vectorDocumentId || document.id || ''),
    vector_document_id: String(document.vectorDocumentId || document.id || ''),
    source_kind: String(document.sourceKind || 'session'),
    workspace_id: String(document.workspaceId || ''),
    channel_id: String(document.channelId || ''),
    project_key: String(document.projectKey || ''),
    runtime: String(document.runtime || ''),
    session_id: String(document.sessionId || ''),
    share_id: String(document.shareId || ''),
    share_section_id: String(document.shareSectionId || ''),
    content_type: String(document.contentType || ''),
    uploader_id: String(document.uploaderId || ''),
    uploader_name: String(document.uploaderName || ''),
    uploader_email: String(document.uploaderEmail || ''),
    uploader_avatar: String(document.uploaderAvatar || ''),
    uploader_search_text: String(document.uploaderSearchText || ''),
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
  const configuredDimension = Number(options.dimension || process.env.MAGCLAW_EMBEDDING_DIMENSION || 0);
  const bm25Field = String(options.bm25Field || DEFAULT_BM25_FIELD).trim() || DEFAULT_BM25_FIELD;
  const bm25TextField = String(options.bm25TextField || DEFAULT_BM25_TEXT_FIELD).trim() || DEFAULT_BM25_TEXT_FIELD;
  const bm25FunctionName = String(options.bm25FunctionName || DEFAULT_BM25_FUNCTION_NAME).trim() || DEFAULT_BM25_FUNCTION_NAME;
  const recreateForBm25 = Boolean(options.recreateForBm25);
  const headers = authorizationHeaders(token);
  function endpointUrl(pathname) {
    if (!endpoint) throw new Error('Zilliz endpoint is not configured.');
    return `${endpoint}${pathname}`;
  }
  async function zillizRequest(pathname, body = {}) {
    const response = await fetchImpl(endpointUrl(pathname), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return readJsonResponse(response);
  }
  function commonBody() {
    return {
      dbName: database,
      collectionName: collection,
    };
  }
  function outputFields() {
    return [
      'vector_document_id',
      'source_kind',
      'workspace_id',
      'channel_id',
      'project_key',
      'runtime',
      'session_id',
      'share_id',
      'share_section_id',
      'content_type',
      'uploader_id',
      'uploader_name',
      'uploader_email',
      'uploader_avatar',
      'uploader_search_text',
      'topic_id',
      'layer',
      'title',
      'text',
      'source_ref',
      'updated_at',
      'hotness',
    ];
  }
  const collectionMissingPattern = /not found|not exist|collection.*not|can'?t find collection|can not find collection|cannot find collection/;
  function ignorableZillizError(error, pattern) {
    const message = String(error?.message || error || '').toLowerCase();
    return pattern.test(message);
  }
  async function describeCollection() {
    return zillizRequest('/v2/vectordb/collections/describe', commonBody());
  }
  function schemaFields(description = {}) {
    return asArray(
      description?.data?.schema?.fields
        || description?.data?.fields
        || description?.schema?.fields
        || description?.fields,
    );
  }
  function schemaFunctions(description = {}) {
    return asArray(
      description?.data?.schema?.functions
        || description?.data?.functions
        || description?.schema?.functions
        || description?.functions,
    );
  }
  function fieldName(field = {}) {
    return String(field.fieldName || field.name || field.field_name || '').trim();
  }
  function bm25SupportStatus(description = {}) {
    const fields = schemaFields(description);
    const functions = schemaFunctions(description);
    const bm25FieldLower = bm25Field.toLowerCase();
    const bm25TextFieldLower = bm25TextField.toLowerCase();
    const hasSparseField = fields.some((field) => (
      fieldName(field).toLowerCase() === bm25FieldLower
      && /sparse/i.test(String(field.dataType || field.type || ''))
    ));
    const textField = fields.find((field) => fieldName(field).toLowerCase() === bm25TextFieldLower) || {};
    const textFieldParams = fieldParams(textField);
    const analyzerParams = textFieldParams.analyzer_params
      || textFieldParams.analyzerParams
      || textField.analyzer_params
      || textField.analyzerParams;
    const hasAnalyzer = bm25TextField !== 'text'
      || textField.enable_analyzer === true
      || textField.enableAnalyzer === true
      || truthyParam(textFieldParams.enable_analyzer)
      || truthyParam(textFieldParams.enableAnalyzer);
    const hasAnalyzerParams = bm25TextField !== 'text'
      || analyzerParamsMatch(analyzerParams);
    const hasFunction = functions.some((fn) => {
      const outputNames = asArray(fn.outputFieldNames || fn.output_field_names || fn.outputs).map((item) => String(item).toLowerCase());
      const inputNames = asArray(fn.inputFieldNames || fn.input_field_names || fn.inputs).map((item) => String(item).toLowerCase());
      const functionType = String(fn.type || fn.functionType || '').toLowerCase();
      return (functionType === 'bm25' || functionType === 'functiontype.bm25' || Number(fn.type || fn.functionType) === 1)
        && outputNames.includes(bm25FieldLower)
        && (!inputNames.length || inputNames.includes(bm25TextFieldLower));
    });
    const serialized = JSON.stringify(description || {}).toLowerCase();
    return {
      ok: hasSparseField && hasFunction && hasAnalyzer && hasAnalyzerParams,
      configured: true,
      hasSparseField: hasSparseField || serialized.includes(bm25FieldLower),
      hasFunction: hasFunction || (serialized.includes('bm25') && serialized.includes(bm25FieldLower)),
      hasAnalyzer,
      hasAnalyzerParams,
    };
  }
  async function dropCollection() {
    try {
      await zillizRequest('/v2/vectordb/collections/drop', commonBody());
    } catch (error) {
      if (!ignorableZillizError(error, collectionMissingPattern)) throw error;
    }
  }
  async function createCollection(collectionDimension) {
    const fields = [
      { fieldName: '_id', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: 512 } },
      { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: collectionDimension } },
      { fieldName: 'vector_document_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'source_kind', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
      { fieldName: 'workspace_id', dataType: 'VarChar', elementTypeParams: { max_length: 256 } },
      { fieldName: 'channel_id', dataType: 'VarChar', elementTypeParams: { max_length: 256 } },
      { fieldName: 'project_key', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'session_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'share_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'share_section_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'content_type', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
      { fieldName: 'uploader_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'uploader_name', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'uploader_email', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'uploader_avatar', dataType: 'VarChar', elementTypeParams: { max_length: 2048 } },
      { fieldName: 'uploader_search_text', dataType: 'VarChar', elementTypeParams: { max_length: 2048 } },
      { fieldName: 'topic_id', dataType: 'VarChar', elementTypeParams: { max_length: 512 } },
      { fieldName: 'layer', dataType: 'VarChar', elementTypeParams: { max_length: 32 } },
      { fieldName: 'title', dataType: 'VarChar', elementTypeParams: { max_length: 4096 } },
      {
        fieldName: 'text',
        dataType: 'VarChar',
        elementTypeParams: {
          max_length: 32766,
          ...(bm25Field && bm25TextField === 'text' ? {
            enable_analyzer: true,
            analyzer_params: defaultBm25AnalyzerParams(),
          } : {}),
        },
      },
      { fieldName: 'source_ref', dataType: 'VarChar', elementTypeParams: { max_length: 4096 } },
      { fieldName: 'updated_at', dataType: 'VarChar', elementTypeParams: { max_length: 64 } },
      { fieldName: 'hotness', dataType: 'Double' },
    ];
    fields.push({ fieldName: bm25Field, dataType: 'SparseFloatVector' });
    await zillizRequest('/v2/vectordb/collections/create', {
      ...commonBody(),
      schema: {
        autoID: false,
        enableDynamicField: true,
        fields,
        functions: [{
          name: bm25FunctionName,
          type: 'BM25',
          inputFieldNames: [bm25TextField],
          outputFieldNames: [bm25Field],
          params: {},
        }],
      },
    });
  }
  async function ensureVectorIndex() {
    try {
      await zillizRequest('/v2/vectordb/indexes/create', {
        ...commonBody(),
        indexParams: [
          {
            metricType: 'COSINE',
            fieldName: 'vector',
            indexName: 'vector',
            indexConfig: {
              index_type: 'AUTOINDEX',
            },
          },
        ],
      });
    } catch (error) {
      if (!ignorableZillizError(error, /already|exist|duplicate/)) throw error;
    }
  }
  async function ensureBm25Index() {
    try {
      await zillizRequest('/v2/vectordb/indexes/create', {
        ...commonBody(),
        indexParams: [
          {
            metricType: 'BM25',
            fieldName: bm25Field,
            indexName: bm25Field,
            indexConfig: {
              index_type: 'AUTOINDEX',
            },
          },
        ],
      });
    } catch (error) {
      if (!ignorableZillizError(error, /already|exist|duplicate|field.*not|not found|not exist/)) throw error;
    }
  }
  async function collectionLoadState() {
    try {
      const data = await zillizRequest('/v2/vectordb/collections/get_load_state', commonBody());
      return String(data?.data?.loadState || data?.data?.state || data?.loadState || data?.state || '');
    } catch {
      return '';
    }
  }
  async function ensureCollectionLoaded() {
    const state = await collectionLoadState();
    if (/^(LoadStateLoaded|Loaded)$/i.test(state)) return;
    try {
      await zillizRequest('/v2/vectordb/collections/load', commonBody());
    } catch (error) {
      if (!ignorableZillizError(error, /already|loaded/)) throw error;
    }
  }
  return {
    async search({ queryVector = [], workspaceId = '', channelId = '', projectKey = '', sessionId = '', layer = '', sourceKind = '', uploaderIds = [], dateRange = null, limit = 40 } = {}) {
      const filter = buildZillizFilter({ workspaceId, channelId, projectKey, sessionId, layer, sourceKind, uploaderIds, dateRange });
      const data = await zillizRequest('/v2/vectordb/entities/search', {
        ...commonBody(),
        data: [queryVector],
        annsField: 'vector',
        limit,
        outputFields: outputFields(),
        ...(filter ? { filter } : {}),
      });
      return {
        ok: true,
        candidates: flattenZillizRows(data).map(zillizCandidate).filter((item) => item.vectorDocumentId),
      };
    },
    async keywordSearch({ query = '', keywordQuery = '', keywords = [], topics = [], workspaceId = '', channelId = '', projectKey = '', sessionId = '', layer = '', sourceKind = '', uploaderIds = [], dateRange = null, limit = 40 } = {}) {
      const filter = buildZillizFilter({ workspaceId, channelId, projectKey, sessionId, layer, sourceKind, uploaderIds, dateRange });
      const queries = zillizKeywordQueries({ query, keywordQuery, keywords, topics });
      if (!queries.length) return { ok: true, candidates: [] };
      const results = await Promise.all(queries.map((keyword) => zillizRequest('/v2/vectordb/entities/search', {
        ...commonBody(),
        data: [keyword],
        annsField: bm25Field,
        metricType: 'BM25',
        limit,
        outputFields: outputFields(),
        ...(filter ? { filter } : {}),
      })));
      return {
        ok: true,
        queries,
        candidates: fuseZillizKeywordCandidates(
          results.map((data) => flattenZillizRows(data).map(zillizKeywordCandidate).filter((item) => item.vectorDocumentId)),
          limit,
        ),
      };
    },
    async upsertDocuments({ documents = [], embeddings = [] } = {}) {
      const data = asArray(documents).map((document, index) => documentEntity(document, embeddings[index] || document.vector || []));
      if (!data.length) return { ok: true, count: 0 };
      const result = await zillizRequest('/v2/vectordb/entities/upsert', {
        ...commonBody(),
        data,
      });
      return {
        ok: true,
        count: Number(result?.data?.upsertCount || result?.data?.insertCount || data.length),
      };
    },
    async ensureCollection({ dimension = 0 } = {}) {
      const collectionDimension = Number(dimension || configuredDimension || 1536);
      let existed = true;
      let recreatedForBm25 = false;
      let description = null;
      let bm25Status = { ok: true, configured: true, createdWithBm25: false };
      try {
        description = await describeCollection();
      } catch (error) {
        if (!ignorableZillizError(error, collectionMissingPattern)) throw error;
        existed = false;
        await createCollection(collectionDimension);
        bm25Status = { ok: true, configured: true, createdWithBm25: true };
      }
      if (existed) {
        bm25Status = bm25SupportStatus(description);
        if (!bm25Status.ok) {
          if (!recreateForBm25) {
            const missing = [
              bm25Status.hasSparseField ? '' : `sparse field "${bm25Field}"`,
              bm25Status.hasFunction ? '' : `BM25 function "${bm25FunctionName}"`,
              bm25Status.hasAnalyzer ? '' : `analyzer on "${bm25TextField}"`,
              bm25Status.hasAnalyzerParams ? '' : `jieba analyzer params on "${bm25TextField}"`,
            ].filter(Boolean).join(', ');
            throw new Error(`Existing Zilliz collection "${collection}" is missing BM25 support${missing ? `: ${missing}` : ''}. Recreate this test collection or use a new collection so MagClaw can create the default BM25 schema.`);
          }
          await dropCollection();
          await createCollection(collectionDimension);
          existed = false;
          recreatedForBm25 = true;
          bm25Status = { ok: true, configured: true, recreatedForBm25: true };
        }
      }
      await ensureVectorIndex();
      await ensureBm25Index();
      await ensureCollectionLoaded();
      return { ok: true, existed, recreatedForBm25, bm25: bm25Status, dimension: collectionDimension };
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
      const detectedDimension = embeddings.find((embedding) => Array.isArray(embedding) && embedding.length)?.length || 0;
      if (typeof zillizClient.ensureCollection === 'function') {
        await zillizClient.ensureCollection({ dimension: detectedDimension });
      }
      const upsert = await zillizClient.upsertDocuments({ documents: activeDocuments, embeddings });
      return {
        ok: true,
        count: Number(upsert?.count || activeDocuments.length),
      };
    },
  };
}
