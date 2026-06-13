function cleanString(value) {
  return String(value || '').trim();
}

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(cleanString(value).toLowerCase());
}

export function assertKnowledgeDeploySafe({
  isCloudDeploy = false,
  isLoginRequired = () => false,
  env = process.env,
  warn = console.warn,
} = {}) {
  if (!isCloudDeploy) return;
  if (typeof isLoginRequired === 'function' && isLoginRequired()) return;
  if (truthyEnv(env.MAGCLAW_ALLOW_OPEN_KNOWLEDGE)) {
    warn?.('[knowledge-space] Open Knowledge Space deployment allowed by MAGCLAW_ALLOW_OPEN_KNOWLEDGE=1. Login is not required.');
    return;
  }
  throw new Error('Knowledge Space login is required for cloud/production deployments.');
}

export function assertKnowledgeSecretConfigured({
  isCloudDeploy = false,
  env = process.env,
  warn = console.warn,
} = {}) {
  if (!isCloudDeploy) return;
  if (cleanString(env.MAGCLAW_KNOWLEDGE_SECRET_KEY)) return;
  warn?.('[knowledge-space] MAGCLAW_KNOWLEDGE_SECRET_KEY is not configured. Feishu app secret encryption will fail closed.');
}
