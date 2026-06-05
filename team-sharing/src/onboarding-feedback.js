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
  return 'MagClaw Team Sharing 已配置';
}

function commandList(setupCommand = '') {
  return [
    setupCommand ? {
      label: '安装到当前项目',
      command: 'team-sharing setup',
      description: '在终端运行页面里的完整 setup 命令，完成登录、项目配置、Hooks 和 Skill 安装。',
    } : null,
    {
      label: '检查状态',
      command: 'team-sharing doctor',
      description: '检查项目配置、登录、Hooks、Skill 和版本更新。',
    },
    {
      label: '检索团队上下文',
      command: 'team-sharing search --query "最近大家怎么处理这个问题？" --limit 5',
      description: '默认同时使用 keyword/BM25 和 semantic/vector recall，再做排序。',
    },
    {
      label: '分享总结产物',
      command: 'team-sharing share-artifact --file ./summary.md --title "团队总结" --type markdown',
      description: '把整理好的 Markdown/HTML/SVG/Mermaid 产物生成 MagClaw 分享链接。',
    },
  ].filter(Boolean);
}

function feedbackSections({ result = {}, setupCommand = '' } = {}) {
  const project = result.project || result;
  const hooks = result.hooks || {};
  const skill = result.skill || result;
  const targets = installedTargets(skill, hooks);
  const events = hookEvents(hooks);
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
      title: '立即可试',
      items: commandList(setupCommand).map((item) => `${item.label}: \`${item.command}\` - ${item.description}`),
    },
    {
      title: '检索与召回',
      items: [
        '默认 hybrid 检索会同时运行 keyword/BM25 和 semantic/vector recall，然后合并与重排结果。',
        '时间范围用 `--time today|yesterday|this-week` 或 `--from/--to`；精确线索用 `--keyword`/`--keywords`；主题线索用 `--topic`/`--topics`。',
        '需要偏向精确匹配或语义理解时用 `--mode keyword` 或 `--mode semantic`；深挖原文用 `team-sharing context --session-id <id> --anchor-event-id <id>`。',
      ],
    },
    {
      title: '总结与分享',
      items: [
        '在 Codex 里可以让 Agent 使用 `magclaw-team-sharing` Skill 总结当前会话、提炼问题和结论。',
        '整理后的 Markdown/HTML 产物可通过 `team-sharing share-artifact` 生成 MagClaw 分享链接。',
        '分享链接访问遵循当前 MagClaw 服务的登录和权限策略，并会显示创建者与创建时间。',
      ],
    },
    {
      title: 'Hooks 机制',
      items: [
        `Codex: ${events.codex.map((item) => `\`${item}\``).join(', ')}；Claude Code: ${events.claude.map((item) => `\`${item}\``).join(', ')}。`,
        'Hooks 会同步清洗后的用户正文、最终回复、计划和交互选择；raw tool output、secret、长命令输出不会上传。',
        '每次同步会写入本地 audit，`team-sharing status` 和 `team-sharing doctor` 可查看最近同步状态。',
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
  setupCommand = '',
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
      ? 'Team Sharing 已可用于检索团队会话、自动沉淀上下文，并生成 MagClaw 分享链接。'
      : 'Team Sharing 还需要处理配置、登录、Hooks 或 Skill 安装问题。',
    sections: feedbackSections({ result, setupCommand }),
    commands: commandList(setupCommand),
    nextSteps: [
      '运行 `team-sharing doctor` 确认本机配置。',
      '在 Codex 里询问“用 magclaw-team-sharing 检索昨天关于某问题的讨论”。',
      '需要对外同步结论时，让 Codex 生成总结文件，再运行 `team-sharing share-artifact`。',
    ],
    expectations: [
      'Hooks 会在会话结束、压缩前或会话开始时自动尝试同步。',
      '同步内容会先做清洗和脱敏，避免上传 raw tool output 或 secrets。',
      'MagClaw 会把会话沉淀成可搜索 workspace，并保留原始上下文跳转。',
    ],
    troubleshooting: [
      '登录过期或服务器不匹配时运行 `team-sharing login`。',
      'Hooks 命令不可执行时运行 `team-sharing hooks install --target all`。',
      'Skill 缺失时运行 `team-sharing skills install --target all`。',
    ],
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
