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

## Commit examples

```text
feat(protocol): define v1 OpsEvent schemas
feat(agent): persist ingested event batches
feat(node-agent): expose bounded docker log evidence
feat(incident): aggregate duplicate events
```
