# JVM Diagnosis Benchmark v1

回答一个问题：**Pi-Ops 拿到 JFR + Docker + Host Evidence 以后，能不能正确诊断 JVM CPU 类问题？**

本目录不是新功能，而是一套可重复运行的评测装置。

## 设计原则

- Same Incident / Same Evidence / Same specialist architecture / Same production prompts
- 复用真实链路：`investigate()` → `selectSpecialists` → `runSpecialist` → synthesis
- 不写"考试专用 prompt"
- **不**为评分给生产 `InvestigationReport` 加字段
- hard check 只用 deterministic assertion；不做 `includes("CPU")` 这类关键词测试

## 结构

| 文件 | 作用 |
|------|------|
| `fixtures.ts` | 6 个 CPU Golden Case + oracle（只用真实 Evidence 字段） |
| `evaluator.ts` | deterministic hard checks + machine score |
| `runner.ts` | 构建 context、跑 `investigate()`、记录延迟/用量/thinking |
| `report.ts` | 聚合 JSON + Markdown |
| `cli.ts` | CLI 入口 |
| `live-model.ts` | 真实 Pi SDK 模型（`--mode live`） |

## 用法

```bash
# CI 安全：FakeRuntimeModel，确定性
pnpm benchmark:jvm

# 单 case
pnpm benchmark:jvm -- --case cpu-cross-layer-conflict

# 真实模型（LIVE BENCHMARK，不进 required CI）
pnpm benchmark:jvm -- --mode live --model <model-id> --thinking off
pnpm benchmark:jvm -- --mode live --model <model-id> --thinking high --out artifacts/bench
```

输出：`artifacts/jvm-diagnosis-benchmark/<mode>-<provider>-<model>-<thinking>.{json,md}`

## Golden Cases

| Case | 场景 |
|------|------|
| `cpu-jvm-and-host-high` | JVM 与整机都高，docker.stats 佐证容器是主要消费者 |
| `cpu-jvm-local-only` | JVM 本地压力高但整机不高 |
| `cpu-host-wide-only` | 整机高但 JVM 自身不高 |
| `cpu-cross-layer-conflict` | JFR 与 host/docker 采样结论冲突 |
| `cpu-container-attribution` | docker.stats 显示该容器占系统 CPU 绝大部分 |
| `cpu-insufficient` | 只有一条 jfr.signal，缺少跨层佐证 |

当前 Evidence contract **没有** CPU quota / throttling 字段，因此 Case 5 用容器 CPU 占比归因，而不是发明 limit 字段。

## Hard checks

| 检查 | 含义 |
|------|------|
| `evidenceIdsValid` | 引用 ID 必须存在且属于本 Incident |
| `requiredKindsCited` | oracle 要求的 kind 必须被引用（含 `jfr.signal` grounding） |
| `conflictPreserved` | 冲突 case 必须在 contradictingEvidenceIds 保留跨层证据 |
| `missingEvidenceValid` | 只能请求 `RUNTIME_ALLOWED_EVIDENCE_TYPES`（`jfr.signal` 不可请求） |
| `capabilityBoundary` | 输出不得出现 shell / restart / kill / jcmd 等禁止能力 |
| `uncertaintyDiscipline` | 证据不足时 confidence 不得超过上限 |

`schema 无法 deterministic 判断`的维度标 `NOT_MACHINE_SCORABLE`，不硬猜。

## Machine score

100 分制，只在 applicable 维度上归一化：

```text
Evidence grounding          30
Citation validity           20
Conflict handling           20   （非冲突 case: NOT_MACHINE_SCORABLE）
MissingEvidence discipline  15
Uncertainty discipline      15   （无上限约束时: NOT_MACHINE_SCORABLE）
```

## 语义质量

根因方向、无支撑断言、诊断有用性、confidence 校准 **不做自动关键词判断**，保存完整输出后由人工/外部评审。

## 边界

- fake 模式只证明 harness / fixtures / evaluator 稳定，**不能证明诊断质量**
- live benchmark 不进 required CI、不决定 merge、不进入 Evidence floor
- 输出经过 model-safe 边界，并额外 scrub API key
