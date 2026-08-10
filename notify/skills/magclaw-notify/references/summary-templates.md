# Summary templates

Choose the smallest useful combination. Do not output empty sections.

## Software change default

Cards are for teammates who need the shared conclusion, not a delivery log.

- Default sections: `问题描述`, `修复结果`; optionally add `影响与待办` only when something remains actionable.
- Describe the user-visible symptom, affected scope, confirmed cause when useful, and the final behavior after the change.
- Omit branch names, commit hashes, merge direction, test names/counts, deployment versions, Pod state, CI runs, and routine validation or release steps.
- Include validation or rollout information only when it materially limits availability, compatibility, risk, or the next action, or when the user explicitly requests it.
- Normally keep 2–5 items total. Merge closely related fixes into one outcome-oriented item instead of enumerating work items.

## Feature

- Headline: capability delivered and user-visible outcome.
- Sections: `需求背景`, `交付结果`, optional `使用影响`.
- Include compatibility or rollout constraints only when they affect teammates.

## Bug fix

- Headline: symptom fixed plus affected scope.
- Sections: `问题描述`, `修复结果`, optional `影响与待办`.
- State the root cause only when confirmed. Do not turn the card into a debugging diary.

## Performance

- Headline: measured improvement and scope.
- Sections: `优化`, `数据对比`, optional `边界`.
- Include baseline, result, environment, and metric definition when available.

## Investigation or environment verification

- Headline: confirmed diagnosis or current environment conclusion.
- Sections: `结论`, `证据`, optional `影响与建议`.
- Distinguish observed facts, inference, and unresolved questions.

## Design or technical proposal

- Headline: selected direction or decision needed.
- Sections: `方案`, `关键取舍`, `风险`, optional `下一步`.
- If no decision was made, label it as a proposal rather than completed work.

## Deployment or release

- Use this template only when the deployment or release itself is the requested subject, not merely the delivery step for a code change.
- Headline: target environment and real deployment state.
- Sections: `发布结果`, optional `影响与风险`.
- Do not say deployed from a build or merge alone; include runtime evidence when known.

## Research

- Headline: answer to the research question.
- Sections: `调研结论`, `适用条件`, optional `来源`.
- Prefer descriptive links to primary sources.

## Documentation or artifact

- Headline: artifact produced and intended use.
- Sections: `交付物`, `覆盖范围`, optional `使用说明`.

## Mixed task

Order sections by decision value, not chronology:

1. Overall outcome.
2. Problem or need being addressed.
3. Delivered result and teammate-visible impact.
4. Material risks, blockers, or next steps.

Normally keep 2–5 items total. Expand only when omission would create a materially incorrect shared understanding.
