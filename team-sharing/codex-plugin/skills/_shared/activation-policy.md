# Explicit Activation Policy

Team Sharing foreground skills cross the boundary from the current chat into
shared team context. Use them only when the user clearly asks for Team Sharing,
not merely because everyday wording overlaps with a feature name.

## Activation Signals

Use foreground Team Sharing skills only when at least one signal is present:

- The user says `Team Sharing`, `TeamShare`, `MagClaw Team Sharing`, or
  `MagClaw Knowledge Space`.
- The user invokes `/team-sharing ...` or a command-shaped request such as
  `team-sharing <command> ...`.
- The user provides a MagClaw Team Sharing share, context, channel, workspace,
  or Knowledge document link.
- The current message is a direct continuation of a previous explicit Team
  Sharing command and the requested follow-up cannot be answered without the
  same Team Sharing surface.

## Non-trigger Examples

Do not run foreground Team Sharing skills for vague natural-language phrases:

- `同步一下进度`
- `对齐一下这个方案`
- `查一下之前讨论`
- `找一下 owner whitelist`
- `搜索一下 0.2.5`
- `看一下这个和标准是否一致`
- `帮我把这个总结分享一下`
- `把这个文档导入知识库`

In those cases, answer from the current workspace or ask a short clarification
only if Team Sharing is truly necessary.

## Session-reporting Exception

`session-reporting` is the exception. Reporting is on by default, and a short
direct current-session command such as `这个 session 不上报`,
`这一轮不进行上报`, or `恢复这个 session 上报` must still work even when the
user does not say Team Sharing.

That exception is only for the reporting state of the current local session.
It does not authorize Team Sharing search, Knowledge alignment, share publishing,
link management, setup, import, export, or edit operations.
