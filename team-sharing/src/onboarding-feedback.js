const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function okStatus(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value.ok !== undefined) return Boolean(value.ok);
  return true;
}

function unique(values = []) {
  return [...new Set(asArray(values).map((item) => String(item || '').trim()).filter(Boolean))];
}

function installedTargets(skill = {}, hooks = {}) {
  const fromSkill = asArray(skill.installed).map((item) => item.target || item.runtime || '');
  const fromHooks = Object.entries(hooks || {})
    .filter(([, value]) => value && typeof value === 'object' && value.runtime)
    .map(([, value]) => value.runtime);
  return unique([...fromSkill, ...fromHooks]).map((target) => (
    target === 'claude_code' ? 'Claude Code' : target === 'codex' ? 'Codex' : target
  ));
}

function projectConfigured(project = {}) {
  return Boolean(project.ok || project.config || project.projectKey || project.workspaceId || project.channelId || project.channelPath);
}

function loggedIn(project = {}) {
  if (project.loggedIn !== undefined) return Boolean(project.loggedIn);
  if (project.authIssue) return false;
  return true;
}

function hookEvents(hooks = {}) {
  const codex = asArray(hooks.codex?.installed).filter(Boolean);
  const claude = asArray(hooks.claude?.installed).filter(Boolean);
  return {
    codex: codex.length ? codex : ['Stop', 'PreCompact', 'SessionStart'],
    claude: claude.length ? claude : ['Stop', 'SessionEnd', 'PreCompact', 'SessionStart'],
  };
}

function statusFor(result = {}) {
  return okStatus(result) ? 'ready' : 'needs_attention';
}

function lineStatus(ok, yes = '已就绪', no = '需要处理') {
  return ok ? yes : no;
}

function operationTitle(operation = '') {
  if (operation === 'status') return 'MagClaw Team Sharing 状态';
  if (operation === 'doctor') return 'MagClaw Team Sharing 检查';
  if (operation === 'hooks') return 'MagClaw Team Sharing Hooks';
  if (operation === 'skills') return 'MagClaw Team Sharing Skill';
  if (operation === 'channel_setup') return 'MagClaw Team Sharing 接入指南';
  return 'MagClaw Team Sharing 已安装';
}

function parseChannelPathTarget(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'mc:' || parsed.hostname !== 'magclaw') return null;
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'server' || parts[2] !== 'channel') return null;
    return {
      serverId: String(parts[1] || '').trim(),
      channelId: String(parts[3] || '').trim(),
    };
  } catch {
    return null;
  }
}

function normalizeServerUrl(value = '') {
  return String(value || 'https://magclaw.multiego.me').trim().replace(/\/+$/, '') || 'https://magclaw.multiego.me';
}

function channelTargetForFeedback(project = {}) {
  const target = project.onboardingTarget || project.target || project.onboarding || {};
  const parsed = parseChannelPathTarget(project.channelPath || project.config?.channel?.path || '');
  const serverUrl = normalizeServerUrl(target.serverUrl || project.serverUrl || project.config?.server_url || project.config?.serverUrl || '');
  const serverId = String(target.serverId || target.workspaceId || project.workspaceId || project.config?.workspace_id || parsed?.serverId || '').trim();
  const serverSlug = String(target.serverSlug || serverId || '').trim();
  const channelId = String(target.channelId || project.channelId || project.config?.channel?.id || parsed?.channelId || '').trim();
  const channelName = String(target.channelName || channelId || '').trim();
  const channelUrl = String(target.channelUrl || (
    serverUrl && serverSlug && channelId
      ? `${serverUrl}/s/${encodeURIComponent(serverSlug)}/channels/${encodeURIComponent(channelId)}`
      : ''
  )).trim();
  return {
    ...target,
    serverUrl,
    serverId,
    serverSlug,
    serverName: String(target.serverName || target.workspaceName || target.serverSlug || serverSlug || 'MagClaw Server').trim(),
    channelId,
    channelName,
    channelUrl,
  };
}

function channelLink(target = {}) {
  if (!target.channelUrl) return target.channelName || target.channelId || '目标 Channel';
  const label = target.channelName || target.channelId || '目标 Channel';
  return `[${label}](${target.channelUrl})`;
}

function feedbackSections({ result = {} } = {}) {
  const project = result.project || result;
  const hooks = result.hooks || {};
  const skill = result.skill || result;
  const targets = installedTargets(skill, hooks);
  const events = hookEvents(hooks);
  const target = channelTargetForFeedback(project);
  const projectOk = projectConfigured(project);
  const skillOk = okStatus(skill);
  const hooksOk = okStatus(hooks);
  const loginOk = loggedIn(project);
  return [
    {
      title: '安装结果',
      items: [
        `项目配置：${lineStatus(projectOk, '已连接到当前 MagClaw 项目', '尚未检测到项目配置')}`,
        `登录状态：${lineStatus(loginOk, '已具备 Team Sharing 权限', '需要重新登录或批准设备登录')}`,
        `目标 Runtime：${targets.length ? targets.join(', ') : 'Codex / Claude Code'}`,
        `Skill：${lineStatus(skillOk, '已安装 magclaw-team-sharing', '需要安装或修复 Skill')}`,
        `Hooks：${lineStatus(hooksOk, '已配置自动同步', '需要安装或修复 Hooks')}`,
      ],
    },
    {
      title: 'Skill 说明',
      items: [
        '`magclaw-team-sharing` Skill 已安装到 Codex / Claude Code 可访问的位置。',
        '它可以检索团队会话、读取共享上下文、整理结论，并把 Markdown/HTML 等产物发布成 MagClaw 分享链接。',
        '使用示例：在 Codex 里说“帮我用 magclaw-team-sharing 搜索这个 Channel 里关于 NPM 发布的问题”。',
      ],
    },
    {
      title: 'Hooks 功能',
      items: [
        `Codex: ${events.codex.map((item) => `\`${item}\``).join(', ')}；Claude Code: ${events.claude.map((item) => `\`${item}\``).join(', ')}。`,
        '正常使用终端里的 Agent 即可，Hooks 会在会话开始、结束、压缩前等节点自动上报清洗后的上下文。',
        '团队成员可以在 MagClaw Channel 中查看、搜索、复用这些上下文，不需要手动复制完整聊天记录。',
      ],
    },
    {
      title: '数据查看',
      items: [
        `MagClaw 服务：${target.serverUrl}`,
        target.channelUrl
          ? `打开 ${channelLink(target)} 查看本项目上报的数据，链接会直接定位到对应 Channel。`
          : `授权后进入 MagClaw，在 Server \`${target.serverName || target.serverId || '当前 Server'}\` 的 Channel \`${target.channelName || target.channelId || '目标 Channel'}\` 查看数据。`,
        'CLI 授权完成后，服务端会确认你已经加入对应 Server/Channel；后续 Hooks 上报会进入这里。',
      ],
    },
  ];
}

export function buildTeamSharingOnboardingFeedback({
  operation = 'setup',
  ok = true,
  project = null,
  hooks = null,
  skill = null,
  shim = null,
} = {}) {
  const result = {
    ok,
    ...(project ? { project } : {}),
    ...(hooks ? { hooks } : {}),
    ...(skill ? { skill } : {}),
    ...(shim ? { shim } : {}),
  };
  const status = statusFor(result);
  return {
    title: operationTitle(operation),
    status,
    summary: status === 'ready'
      ? '安装完成后，你已经获得团队上下文检索、自动同步 Hooks、分享产物发布和 Channel 数据查看能力。'
      : 'Team Sharing 还需要处理配置、登录、Hooks 或 Skill 安装问题。',
    sections: feedbackSections({ result }),
    commands: [],
    nextSteps: [
      '回到 Codex / Claude Code 正常工作，Hooks 会在会话节点自动同步清洗后的上下文。',
      '需要查看上报数据时，打开上面的 MagClaw Channel 链接。',
      '需要复用团队上下文时，在 Agent 对话里直接让 magclaw-team-sharing 检索相关讨论。',
    ],
    expectations: [
      'Hooks 会在会话结束、压缩前或会话开始时自动尝试同步。',
      '同步内容会先做清洗和脱敏，避免上传 raw tool output 或 secrets。',
      'MagClaw 会把会话沉淀成可搜索 workspace，并保留原始上下文跳转。',
    ],
    troubleshooting: [],
    welcome: '欢迎使用 MagClaw 的 Team Sharing 功能。',
  };
}

export function renderTeamSharingFeedbackMarkdown(feedback = {}) {
  const lines = [
    `# ${feedback.title || 'MagClaw Team Sharing'}`,
    '',
    `**状态**: ${feedback.status || 'unknown'}`,
    '',
    feedback.summary || '',
    '',
  ];
  for (const section of asArray(feedback.sections)) {
    lines.push(`## ${section.title}`, '');
    for (const item of asArray(section.items)) lines.push(`- ${item}`);
    if (section.body) lines.push(section.body);
    lines.push('');
  }
  if (asArray(feedback.nextSteps).length) {
    lines.push('## 下一步', '');
    for (const item of feedback.nextSteps) lines.push(`- ${item}`);
    lines.push('');
  }
  if (feedback.welcome) lines.push(feedback.welcome, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function renderTeamSharingFeedbackText(feedback = {}, { color = false } = {}) {
  const markdown = renderTeamSharingFeedbackMarkdown(feedback);
  if (!color) return markdown;
  return markdown
    .replace(/^# (.+)$/m, `${ANSI.bold}${ANSI.green}$1${ANSI.reset}`)
    .replace(/^## (.+)$/gm, `${ANSI.bold}${ANSI.cyan}$1${ANSI.reset}`)
    .replace(/\*\*状态\*\*: ([^\n]+)/, `${ANSI.bold}状态${ANSI.reset}: ${ANSI.yellow}$1${ANSI.reset}`)
    .replace(/`([^`]+)`/g, `${ANSI.dim}$1${ANSI.reset}`);
}
