# Contributing

## Development workflow

Pi-Ops is developed milestone-by-milestone from `docs/plans/PLAN-0001-dual-source-v0.1-implementation.md`.

For each milestone:

1. Read the ADR and plan.
2. Inspect current code before changing it.
3. Implement only the current milestone.
4. Add/update tests.
5. Run typecheck/tests/lint.
6. Update docs/config examples if behavior changed.
7. Commit with a narrow, semantic message.
8. Report changed files, decisions, validation result, and remaining work.

Do not skip ahead to model integration and do not introduce arbitrary shell execution.

## Merge rule (non-negotiable)

`Governance Trust Anchor / final` is the authoritative required check. An agent must
never merge while it is not `success`.

```text
detect = REJECT                -> never merge (deterministic veto)
machine-review failure         -> never merge
Test Governance Gate failure   -> never merge
final != success               -> never merge
BREAK_GLASS authorize waiting   -> wait for the owner's intent confirmation
final = success                -> allowed to merge
```

GitHub technically allowing a merge is **not** governance approval. The absence of
branch protection or required human review is not permission to bypass this rule.
Never enable branch protection, rulesets, or required reviewer approval to
"fix" a red governance check, and never lower an Evidence floor, relabel a proof
grade, or edit an accepted Proof Source to make governance green.

If a check is red, report it as red and stop.

## Language defaults

Commit subject lines and PR titles/bodies default to Chinese. Conventional Commit
types stay English:

```text
feat(agent): 增加 JFR 语义证据投影
fix(agent): 修正 JFR 未识别信号权重
test(governance): 覆盖中文治理摘要渲染
docs(adr): 记录治理人机交互边界
refactor(agent): 拆分证据选择逻辑
```

Machine protocol stays English. Never translate `APPROVE` / `REJECT` / `PASS` /
`MACHINE_REVIEW` / `BREAK_GLASS` / reason codes, and never feed Chinese display
text back into an authorization decision.

## Commit examples

```text
feat(protocol): define v1 OpsEvent schemas
feat(agent): persist ingested event batches
feat(node-agent): expose bounded docker log evidence
feat(incident): aggregate duplicate events
```
