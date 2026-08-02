# Summary templates

Choose the smallest useful combination. Do not output empty sections.

## Feature

- Headline: capability delivered and user-visible outcome.
- Sections: `新增能力`, `使用影响`, `验收`.
- Include compatibility or rollout constraints only when material.

## Bug fix

- Headline: symptom fixed plus affected scope.
- Sections: `问题与修复`, `验证`, optional `风险`.
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

- Headline: target environment and real deployment state.
- Sections: `发布内容`, `环境状态`, `验收`, optional `回滚或风险`.
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
2. Delivered features and fixes.
3. Investigation or design conclusions.
4. Validation and deployment evidence.
5. Risks, blockers, or next steps.

Normally keep 3–7 items total. Expand only when omission would create a materially incorrect shared understanding.
