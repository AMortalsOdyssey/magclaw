function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueValues(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pathVariants(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  const normalized = text.replace(/\\/g, '/');
  return uniqueValues([
    text,
    normalized,
    normalized.replace(/\//g, '\\'),
  ]).filter((item) => item.length >= 4);
}

export function buildTeamSharingPrivacyContext(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const projectPaths = uniqueValues([
    options.projectDir,
    options.projectPath,
    options.cwd,
    ...(Array.isArray(options.projectPaths) ? options.projectPaths : []),
  ]).flatMap(pathVariants);
  const homePaths = uniqueValues([
    options.home,
    env.HOME,
    env.USERPROFILE,
    ...(Array.isArray(options.homePaths) ? options.homePaths : []),
  ]).flatMap(pathVariants);
  return {
    projectPaths,
    homePaths,
  };
}

function replaceKnownPaths(text = '', paths = [], replacement = '[local-path]') {
  let next = String(text || '');
  for (const candidate of paths) {
    if (!candidate || candidate.length < 4) continue;
    next = next.replace(new RegExp(escapeRegExp(candidate), 'gi'), replacement);
  }
  return next;
}

export function redactTeamSharingText(value = '', context = {}) {
  const privacy = context && typeof context === 'object' ? context : {};
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(?:api[_-]?key|token|secret|password|密钥|秘钥|口令|令牌)\s*[：:=]\s*["']?[^\s"',;，。)）]+/gi, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-secret]')
    .replace(/([?&](?:key|api[_-]?key|token|access_token|secret)=)[^\s"'&)）]+/gi, '$1[redacted-secret]')
    .replace(/(App Secret|app_secret|client_secret)(\s*[：:=]\s*)[^\s"',;，。)）]+/gi, '$1$2[redacted-secret]')
    .replace(/\b(HOME|USERPROFILE|USER|USERNAME|LOGNAME)\s*=\s*["']?[^\s"',;，。)）]+/gi, '$1=[local-account]')
    .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9._-]{2,128}\b/g, '[local-account]')
    .replace(/^$/g, '');
}

export function redactTeamSharingLocalText(value = '', context = {}) {
  let next = redactTeamSharingText(value, context);
  next = replaceKnownPaths(next, context?.projectPaths || [], '[local-project]');
  next = replaceKnownPaths(next, context?.homePaths || [], '[local-home]');
  next = next
    .replace(/\bfile:\/\/\/(?:[A-Za-z]:)?[^\s"'<>，。；;、)）]+/g, '[local-path]')
    .replace(/\\\\[^\\/\s"'<>，。；;、)）]+[\\/][^\s"'<>，。；;、)）]+/g, '[local-path]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>，。；;、)）]+/g, '[local-path]')
    .replace(/(^|[\s([{（])\/(?:Users|home|var|tmp|private|Volumes|opt|workspace|repo|mnt|root)\/[^\s"'<>，。；;、)）]+/g, '$1[local-path]');
  return next.trim();
}

export function sanitizeTeamSharingValue(value, key = '', context = {}) {
  const cleanKey = String(key || '').toLowerCase();
  if (/token|authorization|secret|password|api[_-]?key/.test(cleanKey)) return '[redacted]';
  if (typeof value === 'string') return redactTeamSharingLocalText(value, context);
  if (Array.isArray(value)) return value.map((item) => sanitizeTeamSharingValue(item, key, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeTeamSharingValue(childValue, childKey, context),
    ]));
  }
  return value;
}
