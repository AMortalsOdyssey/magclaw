import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  baseNameFromProjectPath,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safePathWithin,
  toPosixPath,
} from './path-utils.js';
import { projectFilePreviewKind } from './project-files.js';

// Agent workspace and isolated Codex-home helpers.
// Runtime code depends on these functions to keep every Agent's files, memory,
// and app-server session state isolated from the user's normal Codex profile.
export function createAgentWorkspaceManager(deps) {
  const {
    addSystemEvent,
    channelAgentIds,
    getState,
    now,
    AGENTS_DIR,
    CODEX_HOME_CONFIG_VERSION,
    CODEX_HOME_SHARED_ENTRIES,
    CODEX_HOME_STALE_SHARED_ENTRIES,
    MAX_AGENT_WORKSPACE_FILE_BYTES,
    MAX_AGENT_WORKSPACE_TREE_ENTRIES,
    SOURCE_CODEX_HOME,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) {
      return getState()[prop];
    },
    set(_target, prop, value) {
      getState()[prop] = value;
      return true;
    },
  });

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function agentDataDir(agent) {
    return path.join(AGENTS_DIR, String(agent?.id || 'unknown'));
  }

  function agentCodexHomeDir(agent) {
    return path.join(agentDataDir(agent), 'codex-home');
  }
  
  async function ensureSymlinkedCodexHomeEntry(codexHome, entryName) {
    const source = path.join(SOURCE_CODEX_HOME, entryName);
    if (!existsSync(source)) return;
    const target = path.join(codexHome, entryName);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) {
        const current = await readlink(target);
        const resolved = path.resolve(path.dirname(target), current);
        if (resolved === source) return;
        await unlink(target);
      } else {
        // Do not overwrite agent-local files. This keeps the isolated home safe if
        // Codex creates local state with the same name in a later release.
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const sourceStat = await stat(source);
    await symlink(source, target, sourceStat.isDirectory() ? 'dir' : 'file');
  }
  
  async function removeStaleCodexHomeEntry(codexHome, entryName) {
    const target = path.join(codexHome, entryName);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) {
        await unlink(target);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function tomlString(value) {
    return JSON.stringify(String(value || ''));
  }

  function codexTrustedProjectPaths() {
    const home = path.resolve(os.homedir());
    const sourceCodexHome = path.resolve(SOURCE_CODEX_HOME);
    const trustRoot = sourceCodexHome === home || sourceCodexHome.startsWith(`${home}${path.sep}`)
      ? home
      : sourceCodexHome;
    return [...new Set([trustRoot].filter(Boolean))];
  }

  function codexTrustConfigLines() {
    return codexTrustedProjectPaths().flatMap((projectPath) => [
      `[projects.${tomlString(projectPath)}]`,
      'trust_level = "trusted"',
      '',
    ]);
  }
  
  async function writeAgentCodexConfig(codexHome) {
    await writeFile(path.join(codexHome, 'config.toml'), [
      '# 由 MagClaw 生成。用于把聊天 Agent 的 Codex 运行环境和用户自己的 Codex App 隔离开。',
      '',
      'wire_api = "responses"',
      '',
      '[features]',
      'memories = false',
      'plugins = true',
      '',
      '[analytics]',
      'enabled = false',
      '',
      ...codexTrustConfigLines(),
    ].join('\n'), 'utf8');
  }
  
  async function writeAgentCodexAgentsFile(codexHome) {
    await writeFile(path.join(codexHome, 'AGENTS.md'), [
      '# MagClaw Agent Runtime',
      '',
      '- 这个 Codex home 由 MagClaw 管理，只用于聊天 Agent 的运行回合。',
      '- 不要在 MagClaw 聊天回合里启动 Codex 原生记忆写入、整理或 profile 更新流程。',
      '- 需要记录长期偏好、专长或表达风格时，使用 MagClaw 受控 memory writeback。',
      '- 当前频道、thread 或 task 的具体指令，以 MagClaw 注入的运行提示为准。',
      '',
    ].join('\n'), 'utf8');
  }

  async function linkSkillEntry(source, target) {
    if (!existsSync(source)) return;
    if (path.resolve(source) === path.resolve(target)) return;
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) {
        const current = await readlink(target);
        const resolved = path.resolve(path.dirname(target), current);
        if (resolved === source) return;
        await unlink(target);
      } else {
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const sourceStat = await stat(source);
    await symlink(source, target, sourceStat.isDirectory() ? 'dir' : 'file');
  }

  async function globalSkillRoots() {
    const candidates = [
      path.join(SOURCE_CODEX_HOME, 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
    const roots = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      roots.push(candidate);
    }
    return roots;
  }

  async function syncSourceSkillsIntoAgentHome(codexHome, agent) {
    const targetSkillsRoot = path.join(codexHome, 'skills');
    await mkdir(targetSkillsRoot, { recursive: true });
    const roots = await globalSkillRoots();
    for (const sourceSkillsRoot of [...roots].reverse()) {
      const entries = await readdir(sourceSkillsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const source = path.join(sourceSkillsRoot, entry.name);
        if (entry.name === '.system' && (entry.isDirectory() || entry.isSymbolicLink())) {
          const targetSystemRoot = path.join(targetSkillsRoot, '.system');
          await mkdir(targetSystemRoot, { recursive: true });
          const systemEntries = await readdir(source, { withFileTypes: true }).catch(() => []);
          for (const systemEntry of systemEntries) {
            const systemSource = path.join(source, systemEntry.name);
            const systemTarget = path.join(targetSystemRoot, systemEntry.name);
            await linkSkillEntry(systemSource, systemTarget).catch((error) => {
              addSystemEvent('agent_skill_link_skipped', `Could not link system skill ${systemEntry.name}: ${error.message}`, {
                agentId: agent?.id,
                source: systemSource,
                target: systemTarget,
              });
            });
          }
          continue;
        }
        if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.isFile()) continue;
        const target = path.join(targetSkillsRoot, entry.name);
        await linkSkillEntry(source, target).catch((error) => {
          addSystemEvent('agent_skill_link_skipped', `Could not link skill ${entry.name}: ${error.message}`, {
            agentId: agent?.id,
            source,
            target,
          });
        });
      }
    }
    const workspaceSkills = path.join(agentDataDir(agent), 'workspace', 'skills');
    await linkSkillEntry(targetSkillsRoot, workspaceSkills).catch((error) => {
      addSystemEvent('agent_skill_link_skipped', `Could not link workspace skills: ${error.message}`, {
        agentId: agent?.id,
        source: targetSkillsRoot,
        target: workspaceSkills,
      });
    });
  }
  async function prepareAgentCodexHome(agent) {
    const codexHome = agentCodexHomeDir(agent);
    await mkdir(codexHome, { recursive: true });
    await Promise.all(CODEX_HOME_STALE_SHARED_ENTRIES.map((entry) => removeStaleCodexHomeEntry(codexHome, entry).catch((error) => {
      addSystemEvent('agent_codex_home_cleanup_skipped', `Could not clean Codex home entry ${entry}: ${error.message}`, {
        agentId: agent?.id,
        codexHome,
        entry,
      });
    })));
    await Promise.all(CODEX_HOME_SHARED_ENTRIES.map((entry) => ensureSymlinkedCodexHomeEntry(codexHome, entry).catch((error) => {
      addSystemEvent('agent_codex_home_link_skipped', `Could not link Codex home entry ${entry}: ${error.message}`, {
        agentId: agent?.id,
        source: path.join(SOURCE_CODEX_HOME, entry),
        codexHome,
      });
    })));
    await writeAgentCodexConfig(codexHome);
    await writeAgentCodexAgentsFile(codexHome);
    await syncSourceSkillsIntoAgentHome(codexHome, agent);
    if (agent.runtimeSessionId && (agent.runtimeSessionHome !== codexHome || Number(agent.runtimeConfigVersion || 0) !== CODEX_HOME_CONFIG_VERSION)) {
      addSystemEvent('agent_runtime_session_reset', `${agent.name} runtime session reset for isolated Codex home config.`, {
        agentId: agent.id,
        previousSessionId: agent.runtimeSessionId,
        previousHome: agent.runtimeSessionHome || SOURCE_CODEX_HOME,
        codexHome,
        previousConfigVersion: Number(agent.runtimeConfigVersion || 0),
        configVersion: CODEX_HOME_CONFIG_VERSION,
      });
      agent.runtimeSessionId = null;
      agent.runtimeLastTurnAt = null;
    }
    agent.runtimeSessionHome = codexHome;
    agent.runtimeConfigVersion = CODEX_HOME_CONFIG_VERSION;
    return codexHome;
  }

  function firstFrontmatterValue(content, keys) {
    const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!match) return '';
    const lines = match[1].split(/\r?\n/);
    for (const key of keys) {
      const line = lines.find((item) => item.toLowerCase().startsWith(`${key.toLowerCase()}:`));
      if (!line) continue;
      return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
    }
    return '';
  }

  function firstMarkdownParagraph(content) {
    return String(content || '')
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
      .split(/\n\s*\n/g)
      .map((block) => block.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim())
      .find(Boolean) || '';
  }

  function skillNameFromPath(absPath) {
    const parent = path.basename(path.dirname(absPath));
    const base = path.basename(absPath, path.extname(absPath));
    return base === 'SKILL' ? parent : base;
  }

  function skillPathScope(absPath, agent) {
    const agentRoot = agent?.id ? agentDataDir(agent) : '';
    const codexHome = agent?.id ? agentCodexHomeDir(agent) : '';
    const sourceHome = path.resolve(SOURCE_CODEX_HOME);
    const resolved = path.resolve(absPath);
    if (agentRoot && resolved.startsWith(path.resolve(agentRoot))) return 'agent';
    if (codexHome && resolved.startsWith(path.resolve(codexHome))) return 'agent';
    if (resolved.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) return 'plugin';
    if (resolved.startsWith(sourceHome)) return 'global';
    return 'workspace';
  }

  function shortenSkillPath(absPath, agent) {
    const resolved = path.resolve(absPath);
    const agentRoot = agent?.id ? path.resolve(agentDataDir(agent)) : '';
    const codexHome = agent?.id ? path.resolve(agentCodexHomeDir(agent)) : '';
    const sourceHome = path.resolve(SOURCE_CODEX_HOME);
    const home = os.homedir();
    if (agentRoot && resolved.startsWith(agentRoot)) return toPosixPath(path.relative(agentRoot, resolved));
    if (codexHome && resolved.startsWith(codexHome)) return toPosixPath(path.relative(codexHome, resolved));
    if (resolved.startsWith(sourceHome)) return toPosixPath(path.join('~/.codex', path.relative(sourceHome, resolved)));
    if (resolved.startsWith(home)) return toPosixPath(path.join('~', path.relative(home, resolved)));
    return resolved;
  }

  async function parseSkillFile(filePath, agent, { source = '' } = {}) {
    const content = await readFile(filePath, 'utf8').catch(() => '');
    const resolvedFilePath = await realpath(filePath).catch(() => filePath);
    const name = firstFrontmatterValue(content, ['name', 'title']) || skillNameFromPath(filePath);
    const description = firstFrontmatterValue(content, ['description', 'summary', 'short_description', 'short-description'])
      || firstMarkdownParagraph(content)
      || 'No description provided.';
    const pluginMatch = resolvedFilePath.match(new RegExp(`${path.sep}plugins${path.sep}cache${path.sep}([^${path.sep}]+)${path.sep}`));
    return {
      id: `${source || skillPathScope(resolvedFilePath, agent)}:${shortenSkillPath(resolvedFilePath, agent)}`,
      name,
      description: description.slice(0, 500),
      path: shortenSkillPath(resolvedFilePath, agent),
      absolutePath: resolvedFilePath,
      scope: source || skillPathScope(resolvedFilePath, agent),
      kind: path.basename(filePath) === 'SKILL.md' ? 'skill' : 'command',
      plugin: pluginMatch?.[1] || '',
    };
  }

  async function scanSkillsDir(root, agent, { source = '' } = {}) {
    const skills = [];
    if (!root || !existsSync(root)) return skills;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.system') continue;
      const abs = path.join(root, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const skillFile = path.join(abs, 'SKILL.md');
        if (existsSync(skillFile)) {
          skills.push(await parseSkillFile(skillFile, agent, { source }));
          continue;
        }
        if (entry.name === '.system') {
          skills.push(...await scanSkillsDir(abs, agent, { source: 'system' }));
        }
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        skills.push(await parseSkillFile(abs, agent, { source: source || 'command' }));
      }
    }
    return skills;
  }

  async function findPluginSkillFiles(root, { maxEntries = 400 } = {}) {
    const found = [];
    async function walk(dir, depth = 0) {
      if (found.length >= maxEntries || depth > 8 || !existsSync(dir)) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.length >= maxEntries) break;
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          if (entry.name === 'skills') {
            const skillDirs = await readdir(abs, { withFileTypes: true }).catch(() => []);
            for (const skillDir of skillDirs) {
              const skillFile = path.join(abs, skillDir.name, 'SKILL.md');
              if ((skillDir.isDirectory() || skillDir.isSymbolicLink()) && existsSync(skillFile)) found.push(skillFile);
            }
            continue;
          }
          await walk(abs, depth + 1);
        }
      }
    }
    await walk(root);
    return found;
  }

  async function listAgentSkills(agent) {
    await ensureAgentWorkspace(agent);
    const codexHome = agentCodexHomeDir(agent);
    const agentRoot = agentDataDir(agent);
    const roots = await globalSkillRoots();
    const globalSkills = [];
    for (const root of roots) globalSkills.push(...await scanSkillsDir(root, agent, { source: 'global' }));
    const globalResolvedRoots = [];
    for (const root of roots) {
      globalResolvedRoots.push(await realpath(root).catch(() => path.resolve(root)));
    }
    const agentSkills = [
      ...await scanSkillsDir(path.join(codexHome, 'skills'), agent, { source: 'agent' }),
      ...await scanSkillsDir(path.join(agentRoot, '.codex', 'skills'), agent, { source: 'agent' }),
      ...await scanSkillsDir(path.join(agentRoot, '.agents', 'skills'), agent, { source: 'agent' }),
    ].filter((skill) => {
      const resolved = path.resolve(skill.absolutePath);
      return skill.scope === 'agent' && !globalResolvedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
    });
    const pluginFiles = await findPluginSkillFiles(path.join(SOURCE_CODEX_HOME, 'plugins', 'cache'));
    const pluginSkills = [];
    for (const file of pluginFiles) pluginSkills.push(await parseSkillFile(file, agent, { source: 'plugin' }));
    const seen = new Set();
    function unique(items) {
      return items.filter((item) => {
        const key = `${item.scope}:${item.name}:${item.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    }
    return {
      agent: { id: agent.id, name: agent.name, codexHome, workspacePath: agentRoot },
      global: unique(globalSkills),
      workspace: unique(agentSkills),
      plugin: unique(pluginSkills),
      tools: [
        'send_message',
        'read_history',
        'search_messages',
        'search_agent_memory',
        'read_agent_memory',
        'list_agents',
        'read_agent_profile',
        'write_memory',
        'list_tasks',
        'create_tasks',
        'claim_tasks',
        'update_task_status',
        'schedule_reminder',
        'list_reminders',
        'cancel_reminder',
      ],
    };
  }
  
  function defaultAgentMemory(agent, options = {}) {
    const role = String(agent?.description || '通用 MagClaw 协作伙伴。').trim();
    const knowledgeBullets = asArray(options.knowledgeBullets);
    const capabilityBullets = asArray(options.capabilityBullets);
    const activeContextBullets = asArray(options.activeContextBullets);
    const recentWorkBullets = asArray(options.recentWorkBullets);
    return [
      `# ${agent?.name || 'Agent'}`,
      '',
      '## 角色',
      `你是 ${agent?.name || '这个 Agent'}，${role}`,
      '',
      '## 知识索引',
      '- `notes/profile.md` - 角色边界、稳定能力和回复习惯。',
      '- `notes/channels.md` - 频道成员、频道规范和协作上下文。',
      '- `notes/agents.md` - 其他 Agent 的专长与交接线索。',
      '- `notes/work-log.md` - 任务记录、长期决策和完成产物。',
      ...knowledgeBullets,
      '',
      '## 能力',
      ...(capabilityBullets.length ? capabilityBullets : ['- 暂无经过真实任务验证的稳定能力。']),
      '',
      '## 当前上下文',
      ...(activeContextBullets.length ? activeContextBullets : ['- 暂无需要跨回合延续的任务。']),
      '',
      '## 近期工作',
      ...(recentWorkBullets.length ? recentWorkBullets : ['- 暂无近期可复用记录。']),
      '',
    ].join('\n');
  }
  
  function defaultAgentProfileNote(agent, options = {}) {
    const role = String(options.roleOverride || agent?.description || '通用 MagClaw 协作伙伴。').trim();
    const skillBullets = asArray(options.skillBullets);
    return [
      `# ${agent?.name || 'Agent'} 档案`,
      '',
      '## 角色',
      role,
      '',
      '## 优势与技能',
      ...(skillBullets.length ? skillBullets : ['- 根据真实完成的任务补充：工具、领域、仓库、工作流或审查强项。']),
      '',
      '## 回复边界',
      '- 共享频道里的开放消息可能会发给多个 Agent；能提供明确价值时再简短回复。',
      '- 用户点名、任务已分配或 thread 已有 owner 时，优先让被点名或已认领的 Agent 主导。',
      '- 广泛询问“谁有空”时，只简短说明可用性，等待明确任务或追问。',
      '- 除非被邀请，不要接管其他 Agent 已经负责的对话。',
      '',
      '## 记忆维护',
      '- `MEMORY.md` 只保留短入口：角色、知识索引、能力、当前上下文和近期工作。',
      '- 详细规则、任务过程、用户偏好和长期决策放入 `notes/`，优先追加到对应子文档。',
      '- 完成有复用价值的任务、学到明确偏好或进入长任务前，更新 memory/notes 便于交接。',
      '',
    ].join('\n');
  }
  
  function defaultAgentChannelsNote(agent) {
    const memberships = (state?.channels || [])
      .filter((channel) => channelAgentIds(channel).includes(agent.id))
      .map((channel) => `- #${channel.name}: ${channel.description || '暂无描述。'}`);
    return [
      `# ${agent?.name || 'Agent'} 频道记忆`,
      '',
      '## 成员频道',
      ...(memberships.length ? memberships : ['- 暂无频道成员记录。']),
      '',
      '## 频道记忆',
      '- 记录频道专属规范、长期工作流和用户偏好。',
      '- 私密 thread/task 细节默认放进 `notes/work-log.md`；只有沉淀为频道共识时才写到这里。',
      '',
    ].join('\n');
  }
  
  function defaultAgentPeersNote(agent) {
    const peers = (state?.agents || [])
      .filter((item) => item.id !== agent.id)
      .map((item) => `- ${item.name}: ${item.description || item.runtime || '暂无专长记录。'}`);
    return [
      `# ${agent?.name || 'Agent'} Agent 协作图谱`,
      '',
      '## 其他 Agent',
      ...(peers.length ? peers : ['- 暂无其他 Agent 记录。']),
      '',
      '## 交接线索',
      '- 当其他 Agent 展现出稳定专长时，在这里补充。',
      '- 请求明显属于其他 Agent 时，指出更合适的 owner。',
      '',
    ].join('\n');
  }
  
  function defaultAgentWorkLogNote(agent, options = {}) {
    const openWorkBullets = asArray(options.openWorkBullets);
    const completedWorkBullets = asArray(options.completedWorkBullets);
    const decisionBullets = asArray(options.decisionBullets);
    const writebackBullets = asArray(options.writebackBullets);
    return [
      `# ${agent?.name || 'Agent'} 工作记录`,
      '',
      '## 进行中',
      ...(openWorkBullets.length ? openWorkBullets : ['- 暂无进行中的长期工作。']),
      '',
      '## 已完成',
      ...(completedWorkBullets.length ? completedWorkBullets : ['- 暂无已完成的长期工作。']),
      '',
      '## 长期决策',
      ...(decisionBullets.length ? decisionBullets : ['- 暂无需要长期保留的决策。']),
      '',
      ...(writebackBullets.length ? ['## 记忆写入记录', ...writebackBullets, ''] : []),
      '',
    ].join('\n');
  }
  
  function defaultAgentWorkspaceReadme(agent) {
    return [
      `# ${agent?.name || 'Agent'} 工作目录`,
      '',
      '这个目录用于保存该 Agent 的临时文件、生成产物、下载资料和交付物。',
      '',
      '- 长期知识放在 `../MEMORY.md` 和 `../notes/`。',
      '- 任务相关文件尽量按项目或任务分组。',
      '',
    ].join('\n');
  }

  function markdownSectionLines(content, headings) {
    const names = asArray(headings).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
    const lines = String(content || '').split(/\r?\n/);
    let start = -1;
    let level = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
      if (!match) continue;
      if (names.includes(match[2].trim().toLowerCase())) {
        start = index + 1;
        level = match[1].length;
        break;
      }
    }
    if (start === -1) return [];
    const collected = [];
    for (let index = start; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})\s+/);
      if (match && match[1].length <= level) break;
      collected.push(lines[index]);
    }
    return collected;
  }

  function markdownSectionText(content, headings) {
    return markdownSectionLines(content, headings).join('\n').trim();
  }

  function uniqueBullets(items) {
    const seen = new Set();
    return asArray(items).filter((item) => {
      const bullet = String(item || '').trim();
      if (!bullet.startsWith('- ')) return false;
      const key = bullet.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function preservedBullets(content, headings, ignoredPatterns = []) {
    return uniqueBullets(markdownSectionLines(content, headings)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .filter((line) => !ignoredPatterns.some((pattern) => pattern.test(line))));
  }

  const GENERIC_MEMORY_KNOWLEDGE = [
    /notes\/profile\.md.*(role|strengths|skills|response boundaries|角色边界)/i,
    /notes\/channels\.md.*(channel membership|频道成员)/i,
    /notes\/agents\.md.*(other agents|其他 Agent)/i,
    /notes\/work-log\.md.*(durable work|任务记录)/i,
  ];
  const GENERIC_MEMORY_CAPABILITIES = [
    /Keep this list to short skill phrases/i,
    /Put detailed task notes in `?notes\/work-log\.md`?/i,
    /暂无经过真实任务验证的稳定能力/,
  ];
  const GENERIC_MEMORY_ACTIVE = [
    /No active task has been recorded yet/i,
    /Before a long task or context-heavy handoff/i,
    /暂无需要跨回合延续的任务/,
  ];
  const GENERIC_MEMORY_RECENT = [
    /No recent durable work has been recorded yet/i,
    /暂无近期可复用记录/,
  ];

  function shouldUpgradeSeededAgentMemory(content) {
    const value = String(content || '');
    if (!value.trim() || value.includes('## 知识索引')) return false;
    const currentEnglishSeed = value.includes('## Key Knowledge')
      && value.includes('## Collaboration Rules')
      && value.includes('notes/profile.md')
      && value.includes('notes/work-log.md');
    const legacySeed = value.includes('## Collaboration Principles')
      && value.includes('## Knowledge Index')
      && value.includes('No durable work log has been recorded yet.');
    return currentEnglishSeed || legacySeed;
  }

  function upgradeSeededAgentMemory(agent, content) {
    return defaultAgentMemory(agent, {
      knowledgeBullets: preservedBullets(content, ['Key Knowledge', 'Knowledge Index'], GENERIC_MEMORY_KNOWLEDGE),
      capabilityBullets: preservedBullets(content, ['Capabilities', 'Skills'], GENERIC_MEMORY_CAPABILITIES),
      activeContextBullets: preservedBullets(content, ['Active Context'], GENERIC_MEMORY_ACTIVE),
      recentWorkBullets: preservedBullets(content, ['Recent Work'], GENERIC_MEMORY_RECENT),
    });
  }

  function shouldUpgradeSeededProfileNote(content) {
    const value = String(content || '');
    return Boolean(value.trim())
      && !value.includes('## 优势与技能')
      && value.includes('## Strengths And Skills')
      && value.includes('## Response Boundaries')
      && value.includes('Add concrete specialties as they become clear from real work.');
  }

  function upgradeSeededProfileNote(agent, content) {
    const roleOverride = markdownSectionText(content, ['Role']);
    return defaultAgentProfileNote(agent, {
      roleOverride,
      skillBullets: preservedBullets(content, ['Strengths And Skills', 'Skills'], [
        /Add concrete specialties as they become clear/i,
        /Keep this list practical/i,
      ]),
    });
  }

  function shouldUpgradeSeededChannelsNote(content) {
    const value = String(content || '');
    return Boolean(value.trim())
      && !value.includes('## 成员频道')
      && value.includes('## Membership')
      && value.includes('## Channel Memory')
      && value.includes('Record channel-specific norms');
  }

  function shouldUpgradeSeededPeersNote(content) {
    const value = String(content || '');
    return Boolean(value.trim())
      && !value.includes('## 其他 Agent')
      && value.includes('## Other Agents')
      && value.includes('## Handoff Cues')
      && value.includes('Update this file when another agent demonstrates');
  }

  function shouldUpgradeSeededWorkLogNote(content) {
    const value = String(content || '');
    return Boolean(value.trim())
      && !value.includes('## 进行中')
      && value.includes('## Open Work')
      && value.includes('## Completed Work')
      && value.includes('## Durable Decisions');
  }

  function upgradeSeededWorkLogNote(agent, content) {
    return defaultAgentWorkLogNote(agent, {
      openWorkBullets: preservedBullets(content, ['Open Work'], [/No open work has been recorded yet/i]),
      completedWorkBullets: preservedBullets(content, ['Completed Work'], [/No completed work has been recorded yet/i]),
      decisionBullets: preservedBullets(content, ['Durable Decisions'], [/No durable decisions have been recorded yet/i]),
      writebackBullets: preservedBullets(content, ['Memory Writebacks', '记忆写入记录']),
    });
  }

  function shouldUpgradeSeededWorkspaceReadme(content) {
    const value = String(content || '');
    return Boolean(value.trim())
      && !value.includes('这个目录用于保存')
      && value.includes('Use this folder for scratch files')
      && value.includes('../MEMORY.md');
  }

  async function writeFileIfMissingOrSeeded(filePath, content, shouldUpgrade, upgradeContent = () => content) {
    if (!existsSync(filePath)) {
      await writeFile(filePath, content);
      return;
    }
    const existing = await readFile(filePath, 'utf8').catch(() => '');
    if (shouldUpgrade(existing)) await writeFile(filePath, upgradeContent(existing));
  }
  
  async function ensureAgentWorkspace(agent) {
    if (!agent?.id) return null;
    const dir = agentDataDir(agent);
    agent.workspacePath = dir;
    await mkdir(path.join(dir, 'notes'), { recursive: true });
    await mkdir(path.join(dir, 'workspace'), { recursive: true });
    const memoryPath = path.join(dir, 'MEMORY.md');
    if (!existsSync(memoryPath)) {
      await writeFile(memoryPath, defaultAgentMemory(agent));
    } else {
      const content = await readFile(memoryPath, 'utf8').catch(() => '');
      if (shouldUpgradeSeededAgentMemory(content)) {
        await writeFile(memoryPath, upgradeSeededAgentMemory(agent, content));
      }
    }
    await writeFileIfMissingOrSeeded(
      path.join(dir, 'notes', 'profile.md'),
      defaultAgentProfileNote(agent),
      shouldUpgradeSeededProfileNote,
      (content) => upgradeSeededProfileNote(agent, content),
    );
    await writeFileIfMissingOrSeeded(
      path.join(dir, 'notes', 'channels.md'),
      defaultAgentChannelsNote(agent),
      shouldUpgradeSeededChannelsNote,
      () => defaultAgentChannelsNote(agent),
    );
    await writeFileIfMissingOrSeeded(
      path.join(dir, 'notes', 'agents.md'),
      defaultAgentPeersNote(agent),
      shouldUpgradeSeededPeersNote,
      () => defaultAgentPeersNote(agent),
    );
    await writeFileIfMissingOrSeeded(
      path.join(dir, 'notes', 'work-log.md'),
      defaultAgentWorkLogNote(agent),
      shouldUpgradeSeededWorkLogNote,
      (content) => upgradeSeededWorkLogNote(agent, content),
    );
    await writeFileIfMissingOrSeeded(
      path.join(dir, 'workspace', 'README.md'),
      defaultAgentWorkspaceReadme(agent),
      shouldUpgradeSeededWorkspaceReadme,
      () => defaultAgentWorkspaceReadme(agent),
    );
    const sessionsPath = path.join(dir, 'sessions.json');
    if (!existsSync(sessionsPath)) {
      await writeFile(sessionsPath, JSON.stringify({
        agentId: agent.id,
        runtime: agent.runtime || 'Codex CLI',
        runtimeSessionId: agent.runtimeSessionId || null,
        runtimeSessionHome: agent.runtimeSessionHome || null,
        runtimeConfigVersion: agent.runtimeConfigVersion || CODEX_HOME_CONFIG_VERSION,
        updatedAt: now(),
      }, null, 2));
    }
    await prepareAgentCodexHome(agent);
    return dir;
  }
  
  async function ensureAllAgentWorkspaces() {
    for (const agent of state?.agents || []) {
      await ensureAgentWorkspace(agent);
    }
  }
  
  async function writeAgentSessionFile(agent) {
    const dir = await ensureAgentWorkspace(agent);
    if (!dir) return;
    await writeFile(path.join(dir, 'sessions.json'), JSON.stringify({
      agentId: agent.id,
      runtime: agent.runtime || 'Codex CLI',
      runtimeSessionId: agent.runtimeSessionId || null,
      runtimeSessionHome: agent.runtimeSessionHome || null,
      runtimeConfigVersion: agent.runtimeConfigVersion || CODEX_HOME_CONFIG_VERSION,
      runtimeLastStartedAt: agent.runtimeLastStartedAt || null,
      runtimeLastTurnAt: agent.runtimeLastTurnAt || null,
      updatedAt: now(),
      todo: [
        'Persist non-Codex runtime sessions once Claude/other runtimes expose stable resume APIs.',
        'Add editable workspace files with conflict detection and audit history.',
      ],
    }, null, 2));
  }
  
  function agentWorkspacePreviewKind(filePath, buffer) {
    return projectFilePreviewKind(filePath, buffer);
  }
  
  async function listAgentWorkspace(agent, rawRelPath = '') {
    const root = await ensureAgentWorkspace(agent);
    const relPath = normalizeProjectRelPath(rawRelPath);
    const dirPath = safePathWithin(root, relPath || '.');
    if (!dirPath) throw httpError(400, 'Agent workspace path must stay inside the agent workspace.');
    const info = await stat(dirPath).catch(() => null);
    if (!info) throw httpError(404, 'Agent workspace path was not found.');
    if (!info.isDirectory()) throw httpError(400, 'Agent workspace path must be a directory.');
    const dirEntries = (await readdir(dirPath, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name)
        : a.isDirectory() ? -1 : 1))
      .slice(0, MAX_AGENT_WORKSPACE_TREE_ENTRIES);
  
    const entries = [];
    for (const entry of dirEntries) {
      const childRelPath = toPosixPath(path.join(relPath, entry.name)).replace(/^\/+/, '');
      const childPath = safePathWithin(root, childRelPath);
      if (!childPath) continue;
      const childInfo = await stat(childPath).catch(() => null);
      if (!childInfo) continue;
      entries.push({
        id: `${agent.id}:${childRelPath}`,
        name: entry.name,
        path: childRelPath,
        kind: entry.isDirectory() ? 'folder' : 'file',
        type: entry.isDirectory() ? 'folder' : mimeForPath(childPath),
        bytes: entry.isDirectory() ? 0 : childInfo.size,
        updatedAt: childInfo.mtime.toISOString(),
      });
    }
  
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        workspacePath: root,
      },
      path: relPath,
      entries,
      truncated: dirEntries.length >= MAX_AGENT_WORKSPACE_TREE_ENTRIES,
    };
  }
  
  async function readAgentWorkspaceFile(agent, rawRelPath = '') {
    const root = await ensureAgentWorkspace(agent);
    const relPath = normalizeProjectRelPath(rawRelPath);
    const filePath = safePathWithin(root, relPath);
    if (!filePath) throw httpError(400, 'Agent workspace file path must stay inside the agent workspace.');
    const info = await stat(filePath).catch(() => null);
    if (!info) throw httpError(404, 'Agent workspace file was not found.');
    if (!info.isFile()) throw httpError(400, 'Agent workspace preview path must be a file.');
    if (info.size > MAX_AGENT_WORKSPACE_FILE_BYTES) {
      throw httpError(413, `Agent workspace preview is limited to ${MAX_AGENT_WORKSPACE_FILE_BYTES} bytes.`);
    }
    const buffer = await readFile(filePath);
    const previewKind = agentWorkspacePreviewKind(filePath, buffer);
    return {
      file: {
        id: `${agent.id}:${relPath}`,
        agentId: agent.id,
        agentName: agent.name,
        name: baseNameFromProjectPath(relPath, agent.name),
        path: relPath,
        absolutePath: filePath,
        type: mimeForPath(filePath),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        previewKind,
        content: previewKind === 'binary' ? '' : buffer.toString('utf8'),
      },
    };
  }

  const CJK_MEMORY_SEARCH_STOP_TERMS = new Set([
    '关于', '相关', '问题', '这个', '那个', '哪些', '哪个', '哪位',
    '找谁', '谁比', '比较', '更适', '适合', '处理', '可以', '一下',
    '知道', '想知', '应该', '需要', '之前', '以后', '现在', '后续',
    '方面', '的人', '的问', '的吗', '什么',
  ]);
  const CJK_MEMORY_SEARCH_SPLIT_TERMS = [
    ...CJK_MEMORY_SEARCH_STOP_TERMS,
    '的是', '的是谁', '谁更', '谁能', '哪一个', '哪一位', '哪个人',
  ].sort((a, b) => b.length - a.length);

  function pushUniqueTerm(terms, term) {
    const value = String(term || '').trim().toLowerCase();
    if (!value || terms.includes(value)) return;
    terms.push(value);
  }

  function hanSignalTerms(value) {
    const text = String(value || '');
    const terms = [];
    const runs = text.match(/[\p{Script=Han}]+/gu) || [];
    for (const run of runs) {
      let cleaned = run;
      for (const stop of CJK_MEMORY_SEARCH_SPLIT_TERMS) {
        cleaned = cleaned.split(stop).join(' ');
      }
      cleaned = cleaned.replace(/[的了呢吗啊呀吧和与及或在是有为到去来问找做]/g, ' ');
      const segments = cleaned
        .split(/\s+/g)
        .map((item) => item.trim())
        .filter((item) => item && !CJK_MEMORY_SEARCH_STOP_TERMS.has(item));
      for (const segment of segments) {
        if (segment.length <= 4) {
          pushUniqueTerm(terms, segment);
          continue;
        }
        for (let size = 2; size <= 3; size += 1) {
          for (let index = 0; index <= segment.length - size; index += 1) {
            const token = segment.slice(index, index + size);
            if (CJK_MEMORY_SEARCH_STOP_TERMS.has(token)) continue;
            pushUniqueTerm(terms, token);
          }
        }
      }
    }
    return terms;
  }

  function memorySearchTerms(query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];
    const hanChars = normalized.match(/[\p{Script=Han}]/gu)?.length || 0;
    const mostlyHan = hanChars > 0 && hanChars / Math.max(1, normalized.length) > 0.45;
    const terms = [];
    if (!mostlyHan) pushUniqueTerm(terms, normalized);
    const spaced = normalized
      .split(/[\s,，。.;；:：!?！？()[\]{}"'`]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
    const scriptTerms = normalized.match(/[a-z0-9_+-]+|[\p{Script=Han}]+/gu) || [];
    for (const item of [...spaced, ...scriptTerms]) {
      if (/^[\p{Script=Han}]+$/u.test(item) && item.length > 4) {
        for (const token of hanSignalTerms(item)) pushUniqueTerm(terms, token);
      } else if (!CJK_MEMORY_SEARCH_STOP_TERMS.has(item)) {
        pushUniqueTerm(terms, item);
      }
    }
    for (const token of hanSignalTerms(normalized)) pushUniqueTerm(terms, token);
    return terms.slice(0, 24);
  }

  function memorySearchPreview(content, lineIndex, terms) {
    const lines = String(content || '').split(/\r?\n/);
    const start = Math.max(0, lineIndex - 1);
    const end = Math.min(lines.length, lineIndex + 2);
    const preview = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
    const fallback = terms[0] || '';
    return (preview || fallback).slice(0, 280);
  }

  function memorySearchLineScore(line, terms) {
    const value = String(line || '').toLowerCase();
    let score = 0;
    const matchedTerms = [];
    for (const term of terms) {
      if (!term || !value.includes(term)) continue;
      score += term.includes(' ') ? 4 : Math.max(1, Math.min(3, term.length));
      matchedTerms.push(term);
    }
    return { score, matchedTerms };
  }

  function memorySearchPathScore(relPath, { purpose = '' } = {}) {
    if (relPath === 'MEMORY.md') return purpose === 'agent_discovery' ? 10 : 5;
    if (relPath === 'notes/profile.md') return purpose === 'agent_discovery' ? 9 : 4;
    if (relPath === 'notes/agents.md' || relPath === 'notes/work-log.md') return purpose === 'agent_discovery' ? -8 : 0;
    return purpose === 'agent_discovery' ? 2 : 0;
  }

  function memorySearchLinePenalty(line, relPath, { purpose = '' } = {}) {
    if (purpose !== 'agent_discovery') return 0;
    const value = String(line || '');
    if (relPath === 'notes/agents.md' || relPath === 'notes/work-log.md') return -8;
    if (/^\s*-\s*\d{4}-\d{2}-\d{2}T.*\[(multi_agent_collaboration|channel_membership_changed|message_sent)\]/.test(value)) return -8;
    if (/^##\s+(Observed Collaboration|Memory Writebacks|协作观察|记忆写入记录)\b/i.test(value)) return -6;
    return 0;
  }

  async function listAgentMemoryFiles(agent) {
    const root = await ensureAgentWorkspace(agent);
    const files = ['MEMORY.md'];
    const notesRoot = safePathWithin(root, 'notes');
    if (!notesRoot) return files;
    async function walk(absDir, relDir) {
      const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relPath = toPosixPath(path.join(relDir, entry.name));
        const absPath = safePathWithin(root, relPath);
        if (!absPath) continue;
        if (entry.isDirectory()) {
          await walk(absPath, relPath);
        } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
          files.push(relPath);
        }
      }
    }
    await walk(notesRoot, 'notes');
    return [...new Set(files)].slice(0, 80);
  }

  function canReadAgentMemoryPath(relPath) {
    const value = normalizeProjectRelPath(relPath || 'MEMORY.md');
    return value === 'MEMORY.md' || (value.startsWith('notes/') && /\.(md|txt)$/i.test(value));
  }

  async function readAgentMemoryFile(agent, rawRelPath = 'MEMORY.md') {
    const relPath = normalizeProjectRelPath(rawRelPath || 'MEMORY.md');
    if (!canReadAgentMemoryPath(relPath)) {
      throw httpError(400, 'Agent memory reads are limited to MEMORY.md and notes/*.md or notes/*.txt.');
    }
    return readAgentWorkspaceFile(agent, relPath);
  }

  async function searchAgentMemory(query, options = {}) {
    const terms = memorySearchTerms(query);
    const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
    const purpose = String(options.purpose || '');
    const excludePaths = new Set(asArray(options.excludePaths).map((item) => normalizeProjectRelPath(item)));
    if (!terms.length) {
      return { ok: false, query: String(query || ''), results: [], text: 'Memory search query is required.' };
    }
    const workspaceId = String(options.workspaceId || '').trim();
    const workspaceScopedAgents = workspaceId
      ? (state.agents || []).filter((agent) => String(agent?.workspaceId || 'local') === workspaceId)
      : (state.agents || []);
    const targetAgents = options.targetAgentId
      ? workspaceScopedAgents.filter((agent) => agent.id === options.targetAgentId || agent.name === options.targetAgentId)
      : workspaceScopedAgents;
    const results = [];
    for (const agent of targetAgents) {
      if (!agent?.id) continue;
      const files = await listAgentMemoryFiles(agent);
      for (const relPath of files) {
        if (excludePaths.has(relPath)) continue;
        const root = await ensureAgentWorkspace(agent);
        const filePath = safePathWithin(root, relPath);
        const info = filePath ? await stat(filePath).catch(() => null) : null;
        if (!info?.isFile() || info.size > MAX_AGENT_WORKSPACE_FILE_BYTES) continue;
        const content = await readFile(filePath, 'utf8').catch(() => '');
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const { score, matchedTerms } = memorySearchLineScore(lines[index], terms);
          if (!score) continue;
          const finalScore = score
            + memorySearchPathScore(relPath, { purpose })
            + memorySearchLinePenalty(lines[index], relPath, { purpose });
          if (finalScore <= 0) continue;
          results.push({
            agentId: agent.id,
            agentName: agent.name,
            agentDescription: agent.description || '',
            path: relPath,
            line: index + 1,
            score: finalScore,
            matchedTerms,
            preview: memorySearchPreview(content, index, terms),
          });
        }
      }
    }
    results.sort((a, b) => b.score - a.score || a.agentName.localeCompare(b.agentName) || a.path.localeCompare(b.path) || a.line - b.line);
    return {
      ok: true,
      query: String(query || ''),
      terms,
      results: results.slice(0, limit),
      truncated: results.length > limit,
    };
  }

  return {
    agentCodexHomeDir,
    agentDataDir,
    agentWorkspacePreviewKind,
    defaultAgentChannelsNote,
    defaultAgentMemory,
    defaultAgentPeersNote,
    defaultAgentProfileNote,
    defaultAgentWorkLogNote,
    defaultAgentWorkspaceReadme,
    ensureAgentWorkspace,
    ensureAllAgentWorkspaces,
    listAgentSkills,
    listAgentWorkspace,
    prepareAgentCodexHome,
    readAgentMemoryFile,
    readAgentWorkspaceFile,
    searchAgentMemory,
    shouldUpgradeSeededAgentMemory,
    writeAgentSessionFile,
  };
}
