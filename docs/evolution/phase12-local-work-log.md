# Phase 12 本机实验记录

这是历史操作记录，不是现行架构说明。现行语义以 `docs/local-integration.md` 和代码为准。

GitHub 能复现代码和单测。本机 incident / SQLite / 模型日志没有入库。

## 提交（历史）

| commit | 内容 |
|--------|------|
| `daa943f` | `pnpm smoke:pi`：缺凭证失败；禁止 FakeRuntimeModel 回退 |
| `bdaf1b7` | 曾把 DataAsset 写进默认 health target（后来改成 opt-in overlay） |
| `b3898c1` | **REJECTED / INVALID SEMANTICS**：Pi-Ops 在连不上 Node Agent 时合成 `http.probe status=succeeded healthy=false`。那不是 Node Agent 的观察，不能当作验收语义。 |
| `0ee9c19` | 文档-only 记录，不关闭架构缺口 |

## 只在本机做过、未入库

- RAGFlow 本地栈、DataAsset `dev_jdk17` Docker、pause 注入。这些是实验，不是默认 Phase 12A 基线。

## 实验（不要当成现行验收）

1. `pnpm smoke:pi` 曾对 **pi-ops-drill** structural PASS（真实模型）。
2. DataAsset incident `inc-e46ecab6-...`：手动 POST 调查。假成功。
3. DataAsset incident `inc-9ae5c6ae-...`：自动 COMPLETED，但当时依赖已被拒绝的「Pi-Ops 合成 unhealth」语义。

## 现行语义（代码关闭后）

- 目标不可达且 Node Agent 返回了 Evidence → `succeeded` + `healthy=false`
- Pi-Ops ↔ Node Agent 传输失败 → retryable，不合成目标健康
- `/v1/ops/*` 只用 `local-operator-token`
- 默认 smoke 只认 `service=pi-ops-drill` `nodeId=local-dev` `type=health.failure`
- DataAsset 探测：`deploy/local/compose.env.dataasset`
