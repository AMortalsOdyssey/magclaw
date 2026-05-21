const DEVELOPMENT_FULL_ACCESS_PATTERNS = [
  /(给你|开放|授予|允许).{0,20}(开发)?(完全|完整|全部|full).{0,20}(访问|权限|access)/i,
  /(开发|dev).{0,12}(完全|完整|全部|full).{0,12}(访问|权限|access)/i,
  /\b(full access|developer access|development access)\b/i,
];

const TEST_DEPLOYMENT_PATTERNS = [
  /(以后|后续|以后都|今后).{0,30}(运行|跑|触发).{0,20}(流水线|pipeline).{0,40}(不需要|不用|无需).{0,12}(确认|审批)/i,
  /(以后|后续|以后都|今后).{0,30}(部署|发布).{0,12}(测试环境|test).{0,40}(不需要|不用|无需).{0,12}(确认|审批)/i,
  /(运行|跑|触发).{0,20}(流水线|pipeline).{0,20}(部署|发布).{0,12}(测试环境|test).{0,40}(有这个权限|可以直接|不需要.*确认)/i,
];

const BASE_ALLOWED_OPERATIONS = [
  '读写 Agent workspace、用户明确给出的项目路径，以及任务相关的临时文件。',
  '执行常规开发命令：git status/fetch/pull/clone、安装依赖、运行测试/构建、启动本地服务、查看日志和只读诊断。',
  '在不触达生产环境的前提下操作测试环境、测试流水线和本地验证流程。',
];

const BASE_CONFIRMATION_REQUIRED = [
  '删除整个项目目录、批量删除用户文件、覆盖不可恢复内容，或执行 rm -rf 这类破坏性命令。',
  'git reset --hard、强推、回滚、取消/终止正在运行的任务或流水线。',
  '生产部署、test+prod 无法拆分的流水线、生产升级、部署配置变更。',
  '数据库迁移/清库/批量写入、sudo、系统配置、权限/所有权修改、密钥/cookie/token 处理。',
];

function cleanText(value, limit = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => cleanText(value, 260)).filter(Boolean))];
}

export function inferAgentPermissionGrant(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (matchesAny(raw, TEST_DEPLOYMENT_PATTERNS)) {
    return {
      kind: 'test_deployment_without_confirmation',
      summary: '用户授权：以后运行流水线并且仅部署测试环境时，不需要额外确认。',
      allowed: [
        '运行可限定在测试环境的流水线。',
        '点击或执行测试环境部署、测试环境升级和测试验证。',
      ],
      requiresConfirmation: [
        '生产部署、生产升级、生产回滚。',
        'test+prod 混合流水线无法只跑测试环境的情况。',
        '取消/终止运行、回滚、修改部署配置。',
      ],
      sourceText: cleanText(raw, 260),
    };
  }

  if (matchesAny(raw, DEVELOPMENT_FULL_ACCESS_PATTERNS)) {
    return {
      kind: 'development_full_access',
      summary: '用户授权：允许 Agent 在这台机器上进行常规开发访问和执行。',
      allowed: [
        '在 Agent workspace 和用户明确给出的项目路径内读写文件。',
        '执行开发命令、安装依赖、运行测试、启动本地服务、clone/pull 仓库。',
        '查看本机 daemon 日志、workspace 文件和任务相关运行证据。',
      ],
      requiresConfirmation: BASE_CONFIRMATION_REQUIRED,
      sourceText: cleanText(raw, 260),
    };
  }

  return null;
}

export function normalizeAgentPermissionGrants(grants = []) {
  return (Array.isArray(grants) ? grants : [])
    .filter((grant) => grant && typeof grant === 'object' && grant.kind)
    .map((grant) => ({
      kind: String(grant.kind),
      summary: cleanText(grant.summary, 260),
      allowed: uniqueStrings(grant.allowed),
      requiresConfirmation: uniqueStrings(grant.requiresConfirmation),
      sourceMessageId: grant.sourceMessageId ? String(grant.sourceMessageId) : null,
      grantedAt: grant.grantedAt ? String(grant.grantedAt) : null,
      updatedAt: grant.updatedAt ? String(grant.updatedAt) : null,
    }));
}

export function recordAgentPermissionGrant(agent, grant, { now = () => new Date().toISOString(), sourceMessageId = null } = {}) {
  if (!agent || !grant?.kind) return false;
  const grants = normalizeAgentPermissionGrants(agent.permissionGrants);
  const existingIndex = grants.findIndex((item) => item.kind === grant.kind);
  const next = {
    kind: String(grant.kind),
    summary: cleanText(grant.summary, 260),
    allowed: uniqueStrings(grant.allowed),
    requiresConfirmation: uniqueStrings(grant.requiresConfirmation),
    sourceMessageId: sourceMessageId ? String(sourceMessageId) : null,
    grantedAt: now(),
    updatedAt: null,
  };
  if (existingIndex >= 0) {
    const existing = grants[existingIndex];
    const same = existing.summary === next.summary
      && JSON.stringify(existing.allowed) === JSON.stringify(next.allowed)
      && JSON.stringify(existing.requiresConfirmation) === JSON.stringify(next.requiresConfirmation);
    if (same) {
      agent.permissionGrants = grants;
      return false;
    }
    grants[existingIndex] = {
      ...existing,
      ...next,
      grantedAt: existing.grantedAt || next.grantedAt,
      updatedAt: now(),
    };
  } else {
    grants.push(next);
  }
  agent.permissionGrants = grants;
  return true;
}

export function renderAgentPermissionGuidance(agent = {}) {
  const grants = normalizeAgentPermissionGrants(agent.permissionGrants);
  const lines = [
    'Operation permission profile:',
    '- 默认允许常规开发操作：' + BASE_ALLOWED_OPERATIONS.join(' '),
    '- 高风险动作必须先确认：' + BASE_CONFIRMATION_REQUIRED.join(' '),
    '- 固定确认句：要求用户回复 `确认执行 <动作/路径>` 或同等明确确认后，再执行对应高风险动作。',
    '- 不要因为需要确认就停止任务；先说明影响、等待用户确认，确认后继续完成剩余工作。',
  ];
  if (grants.length) {
    lines.push('- 已持久授权的默认操作：');
    for (const grant of grants) {
      lines.push(`  - ${grant.summary}${grant.allowed.length ? ` 可直接执行：${grant.allowed.join(' ')}` : ''}${grant.requiresConfirmation.length ? ` 仍需确认：${grant.requiresConfirmation.join(' ')}` : ''}`);
    }
  } else {
    lines.push('- 当前没有额外持久授权；按默认开发权限和高风险确认边界执行。');
  }
  return lines.join('\n');
}

export function permissionGrantMemory(grant) {
  if (!grant?.kind) return null;
  return {
    kind: 'preference',
    summary: cleanText(`${grant.summary} 高风险边界：${uniqueStrings(grant.requiresConfirmation).join('；')}`, 180),
    sourceText: grant.sourceText || grant.summary || '',
  };
}

function commandLooksHighRisk(command) {
  const value = String(command || '').toLowerCase();
  if (!value) return false;
  return [
    /\bsudo\b/,
    /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+push\b.*(--force|-f\b)/,
    /\b(drop\s+database|truncate\s+table|delete\s+from)\b/,
    /\b(terraform|tofu)\s+(apply|destroy)\b/,
    /\bhelm\s+(upgrade|rollback|delete|uninstall)\b/,
    /\bkubectl\s+(delete|apply|replace|rollout|scale|patch)\b/,
    /(生产|prod|production).{0,30}(部署|发布|升级|回滚|deploy|release|upgrade|rollback)/,
    /(部署|发布|升级|回滚|deploy|release|upgrade|rollback).{0,30}(生产|prod|production)/,
    /(取消|终止|terminate|cancel).{0,30}(流水线|pipeline|部署|deploy)/,
  ].some((pattern) => pattern.test(value));
}

function fileChangeLooksHighRisk(params = {}) {
  const changes = Array.isArray(params.changes) ? params.changes : [];
  return changes.some((change) => {
    const action = String(change?.action || change?.kind || change?.type || '').toLowerCase();
    const filePath = String(change?.path || change?.uri || '');
    if (/(delete|remove|unlink|rmdir)/.test(action)) return true;
    if (/\/(\.ssh|\.gnupg|Library\/Keychains)\b/.test(filePath)) return true;
    return false;
  });
}

export function codexPermissionDecision(method, params = {}) {
  const name = String(method || '');
  let highRisk = false;
  if (name === 'item/commandExecution/requestApproval') {
    highRisk = commandLooksHighRisk(params.command);
  } else if (name === 'item/fileChange/requestApproval') {
    highRisk = fileChangeLooksHighRisk(params);
  }
  if (highRisk) {
    return {
      decision: 'decline',
      reason: 'high_risk_requires_user_confirmation',
      result: name === 'item/permissions/requestApproval' ? { permissions: {} } : { decision: 'decline' },
    };
  }
  if (name === 'item/permissions/requestApproval') {
    return {
      decision: 'approve',
      reason: 'default_development_access',
      result: { permissions: params.permissions && typeof params.permissions === 'object' ? params.permissions : {} },
    };
  }
  return {
    decision: 'approve',
    reason: 'default_development_access',
    result: { decision: 'approve' },
  };
}
