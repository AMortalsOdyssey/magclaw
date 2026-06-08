const MAGCLAW_PERF_ENTRY_LIMIT = 240;

function magclawPerfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function magclawPerfDetailValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value.slice(0, 160);
  if (Array.isArray(value)) return { length: value.length };
  if (typeof value === 'object') return '[object]';
  return String(value).slice(0, 160);
}

function magclawPerfDetail(detail = {}) {
  if (!detail || typeof detail !== 'object') return {};
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, 24)
      .map(([key, value]) => [String(key).slice(0, 64), magclawPerfDetailValue(value)]),
  );
}

function magclawPerfState() {
  if (!globalThis.__magclawPerf || typeof globalThis.__magclawPerf !== 'object') {
    globalThis.__magclawPerf = {
      version: 1,
      entries: [],
      clear() {
        this.entries.length = 0;
      },
      snapshot() {
        return this.entries.map((entry) => ({ ...entry, detail: { ...(entry.detail || {}) } }));
      },
      latest(count = 20) {
        const safeCount = Math.max(1, Math.min(200, Number(count || 20) || 20));
        return this.snapshot().slice(-safeCount);
      },
    };
  }
  return globalThis.__magclawPerf;
}

function magclawPerfRecord(entry = {}) {
  const state = magclawPerfState();
  const normalized = {
    ...entry,
    at: Math.round(Number(entry.at || magclawPerfNow())),
    detail: magclawPerfDetail(entry.detail || {}),
  };
  state.entries.push(normalized);
  if (state.entries.length > MAGCLAW_PERF_ENTRY_LIMIT) {
    state.entries.splice(0, state.entries.length - MAGCLAW_PERF_ENTRY_LIMIT);
  }
  return normalized;
}

function magclawPerfBrowserMark(name, detail = {}) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  try {
    performance.mark(name, { detail: magclawPerfDetail(detail) });
  } catch {
    try {
      performance.mark(name);
    } catch {
      // Performance marks are diagnostic only.
    }
  }
}

function magclawPerfBrowserMeasure(name, startMark, endMark, detail = {}) {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  try {
    performance.measure(name, { start: startMark, end: endMark, detail: magclawPerfDetail(detail) });
  } catch {
    try {
      performance.measure(name, startMark, endMark);
    } catch {
      // Performance measures are diagnostic only.
    }
  }
}

let magclawPerfSeq = 0;

function magclawPerfMark(name, detail = {}) {
  const cleanDetail = magclawPerfDetail(detail);
  magclawPerfBrowserMark(name, cleanDetail);
  return magclawPerfRecord({
    type: 'mark',
    name,
    at: magclawPerfNow(),
    detail: cleanDetail,
  });
}

function magclawPerfStart(name, detail = {}) {
  const id = ++magclawPerfSeq;
  const startedAt = magclawPerfNow();
  const startMark = `${name}:start:${id}`;
  const cleanDetail = magclawPerfDetail(detail);
  magclawPerfBrowserMark(startMark, cleanDetail);
  return { id, name, startedAt, startMark, detail: cleanDetail };
}

function magclawPerfEnd(span, detail = {}) {
  if (!span?.name) return null;
  const endedAt = magclawPerfNow();
  const endMark = `${span.name}:end:${span.id}`;
  const cleanDetail = magclawPerfDetail({ ...(span.detail || {}), ...(detail || {}) });
  magclawPerfBrowserMark(endMark, cleanDetail);
  magclawPerfBrowserMeasure(span.name, span.startMark, endMark, cleanDetail);
  if (typeof performance !== 'undefined' && typeof performance.clearMarks === 'function') {
    try {
      performance.clearMarks(span.startMark);
      performance.clearMarks(endMark);
    } catch {
      // Browsers may reject clearing marks created without names.
    }
  }
  return magclawPerfRecord({
    type: 'measure',
    name: span.name,
    at: endedAt,
    duration: Math.max(0, Math.round((endedAt - Number(span.startedAt || endedAt)) * 10) / 10),
    detail: cleanDetail,
  });
}

function magclawPerfMeasureSinceNavigation(name, detail = {}) {
  const duration = magclawPerfNow();
  const cleanDetail = magclawPerfDetail(detail);
  return magclawPerfRecord({
    type: 'measure',
    name,
    at: duration,
    duration: Math.max(0, Math.round(duration * 10) / 10),
    detail: cleanDetail,
  });
}

function magclawPerfTrack(name, detail, callback) {
  const span = magclawPerfStart(name, detail);
  try {
    const result = callback();
    magclawPerfEnd(span, { ok: true, result: Boolean(result) });
    return result;
  } catch (error) {
    magclawPerfEnd(span, { ok: false, error: error?.name || 'Error' });
    throw error;
  }
}

async function magclawPerfTrackAsync(name, detail, callback) {
  const span = magclawPerfStart(name, detail);
  try {
    const result = await callback();
    magclawPerfEnd(span, { ok: true, result: Boolean(result) });
    return result;
  } catch (error) {
    magclawPerfEnd(span, { ok: false, error: error?.name || 'Error' });
    throw error;
  }
}

magclawPerfMark('magclaw:boot:perf-helper-ready');
