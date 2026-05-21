export const PROGRESSIVE_DISCLOSURE_HEADING = '渐进式披露';

export const PROGRESSIVE_DISCLOSURE_SECTION = [
  `## ${PROGRESSIVE_DISCLOSURE_HEADING}`,
  '- 其他 Agent 默认只会先读取本文件；不要假设它们已经看到 `notes/` 或 `workspace/` 中的详细文件。',
  '- 如果信息不足、但已经知道具体需要什么内容，请再次请求明确路径，例如 `read_agent_memory(targetAgentId="<agent-id>", path="notes/profile.md")` 或 `read_agent_file(targetAgentId="<agent-id>", path="workspace/<file>")`。',
  '- 本文件只放入口索引、能力边界和路径线索；详细规则、任务记录和交付物放入 `notes/` 或 `workspace/` 的明确文件。',
].join('\n');

export function memoryHasProgressiveDisclosure(content) {
  return /^##\s+渐进式披露\s*$/m.test(String(content || ''));
}

export function ensureProgressiveDisclosureSection(content) {
  const value = String(content || '').replace(/\s+$/u, '');
  if (memoryHasProgressiveDisclosure(value)) return `${value}\n`;
  if (!value.trim()) return `${PROGRESSIVE_DISCLOSURE_SECTION}\n`;
  return `${value}\n\n${PROGRESSIVE_DISCLOSURE_SECTION}\n`;
}
