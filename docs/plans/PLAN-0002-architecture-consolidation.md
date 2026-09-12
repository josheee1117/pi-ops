# PLAN-0002: 架构收敛与 v0.1 DoD 关闭

- **Status**: Ready for Implementation
- **Date**: 2026-09-12
- **Executor**: AI Coding Agent（一次一个里程碑）
- **Architecture**: ADR-0001、ADR-0025 不变
- **Input**: 2026-09-12 架构评审结论（见 §1）

## 0. 执行代理必读规则

开工前读：

```text
README.md
CONTRIBUTING.md
docs/adr/ADR-0001-dual-source-node-agent-architecture.md
docs/adr/ADR-0025-external-bounded-multi-agent-runtime.md
docs/plans/PLAN-0002-architecture-consolidation.md   （本文件）
tools/test-governance/README.md
```

规则：

1. 一次只做一个里程碑。每个里程碑独立分支、独立 PR、独立可回滚。
2. 每个里程碑结束前必须本地跑通：

   ```bash
   pnpm typecheck
   pnpm test
   pnpm test:governance
   node tools/test-governance/src/cli.mjs plan --strict
   ```

   `plan --strict` 非零退出时不得提 PR，先按 §0.1 处理。
3. 不新增基础设施依赖，不新增 npm 依赖。stdlib 优先。
4. 不触碰 v0.1 只读边界：无 shell、无 restart/kill、无写操作。
5. 不改 `packages/protocol` 的 wire contract（DataAsset 依赖它）。
6. Commit subject 中文、Conventional Commit type 英文，见 CONTRIBUTING.md。
7. 每个里程碑结束提交一份完成报告：改动文件、决策、验证命令输出摘要、遗留项。
8. 标记为 **[OWNER]** 的步骤需要仓库 owner 决策或审批，代理不得自行推进，停下来报告。

### 0.1 治理工具的硬约束（删代码前必读）

`tools/test-governance` 的 Policy Delta Guard 对下面任何一项都会判 `GOVERNANCE_POLICY_WEAKENING` 并 fail closed：

- 从 `config/features.json` 删除 Feature、删除 `paths` 条目、删除 Invariant、降低 Evidence floor
- 从 `config/catalog.json` 删除或降级 `PINNED` 条目
- 缩小 `architecture-guards.json` 的 scope/patterns

对策，按优先级：

1. **先查后删**。删任何源文件前执行：

   ```bash
   grep -n "<文件相对路径>" tools/test-governance/config/features.json tools/test-governance/config/catalog.json tools/test-governance/config/architecture-guards.json
   ```

   无命中：直接删。
2. **有命中但只在 catalog 且 status 为 ACTIVE（非 PINNED）**：连同 catalog 条目一起删，跑 `cli.mjs validate`。
3. **命中 features.json paths 或 PINNED**：该改动会触发 `HUMAN_REQUIRED`，必须走 GitHub Environment `governance-review`。代理在 PR 描述里写清"本 PR 预期 GOVERNANCE_POLICY_WEAKENING，原因：<删除的文件已从入口不可达 / 已被 ADR-00xx 取代>"，然后 **[OWNER]** 审批。绝不通过"把路径留着指向不存在的文件"来绕过。

只增不减的改动（新 Feature path、新 catalog 条目、更高 floor）是 strengthening，直接通过。

## 1. 评审结论摘要（本计划的依据）

架构骨架成立，问题是叠加而非设计。按严重程度：

| # | 问题 | 证据 |
|---|------|------|
| P1 | apps/agent 同时保留进程内 PiReasoner 与外部 pi-runtime 两条推理路径；`delegated-result-ingestion.ts` 从入口不可达 | `apps/agent/src/index.ts` 同时装配两者；只有测试引用 delegated-result-ingestion |
| P2 | Memory 子系统运行时断路：candidate 会写入，但 approve/reject/feedback 无任何路由或 worker 调用，ACTIVE 条目永远为空 | `grep approve\|feedback apps/agent/src/app.ts` 无结果 |
| P3 | 治理工具 8187 行 mjs + 2621 行 JSON，约为产品源码的 3/4；近 30 次提交近半在修治理 | `wc -l tools/test-governance/**` |
| P4 | PLAN-0001 DoD 未关闭：无两节点部署、S1 白盒被记为实验、S3/S5 无 A 级证据、3 个 P1 floor 缺口 | `docs/testing/test-gap-report.md`、`docs/evolution/phase12-local-work-log.md` |
| P5 | `store.ts` 3437 行、26 表、115 方法；迁移靠 try/ALTER 而非 `PRAGMA user_version` | `apps/agent/src/store.ts:1519-1756` |
| P6 | ADR 编号缺 0002-0005、0007；两个 ADR-0019；0021/0023 同名；docs/README 列 29 个 source of truth | `ls docs/adr` |
| P7 | 三服务 Bearer 用 `!==` 比较；9 处手写 AbortController+setTimeout | `grep -n "Bearer" apps/*/src/app.ts` |
| P8 | Live benchmark 单模型单场景；thinking=high 时 2/6 因"输出未通过结构化校验"失败 | `artifacts/jvm-diagnosis-benchmark/live-cpa-glm-latest-high-r1.md` |

评审中一处需要修正：`delegation-task.ts` 不是死代码，它是 ADR-0025 attempt graph 的一部分（一个 InvestigationSession 拥有一个 DelegationTask），**不得删除**。

## 2. 里程碑总览

```text
M1  文档收敛（无代码改动）                      风险低   ~0.5 天
M2  小型加固：timingSafeEqual + AbortSignal.timeout   风险低   ~0.5 天
M3  删除不可达代码 delegated-result-ingestion   风险低   ~0.5 天
M4  移除进程内 PiReasoner 路径                  [OWNER]  ~1 天
M5  关闭 3 个 P1 Evidence 缺口                  风险中   ~2 天
M6  S3 OOM / S5 洪泛 compose 演练               风险中   ~1 天
M7  pi-session 结构化输出修复重试 + benchmark 扩展   需凭证  ~2 天
M8  store.ts 迁移改 user_version + 按域拆文件   风险中   ~2 天
M9  Memory 子系统去留                           [OWNER]  视决策
M10 治理工具瘦身                                [OWNER]  视决策
```

M1→M3 顺序执行。M4 等 owner。M5/M6 可并行。M7 需要 live 凭证。M8 独立。M9 在 M7 数据出来后决策。M10 独立且全程 owner 主导。

---

# M1 — 文档收敛

## Goal

让新代理只读一页就知道当前架构，并把已被取代的 ADR 标出来。

## Steps

1. 新建 `docs/adr/ADR-0029-reasoning-plane-consolidation.md`，内容：
   - Status: Accepted
   - Decision: 外部 `apps/pi-runtime` 是唯一推理平面；`apps/agent` 内不再保留任何模型调用；`reasonerType=fake` 仅用于确定性本地模式与测试。
   - Supersedes: ADR-0011、ADR-0012、ADR-0013、ADR-0014（过渡期 delegation submit/poll 契约与 delegated result ingest 已由 ADR-0025 的 callback 模型取代）。
   - 明确保留：DelegationTask 作为 attempt graph 的生命周期记录仍然存在（ADR-0025）。
2. 修改被取代的四个 ADR：`- **Status**: Superseded by ADR-0029`。
3. `ADR-0023` 改名为 `ADR-0023-investigation-knowledge-graph-phase8.md`，`ADR-0021` 顶部加一行 Note 指向 0023。用 `git mv`。
4. 删除 `docs/adr/ADR-0019-pi-runtime-contract-hardening.md`（已标 Superseded，内容被同号文件覆盖）。在 0019-production-contract 顶部加 Note 说明原 hardening 版本已删除并指向 git history。
5. 重写 `docs/README.md`：
   - 第一节：当前架构一段话 + 三服务职责表 + 一张 ASCII 流程图（可从 README.md 复制）
   - 第二节：ADR 索引表，三列：编号、标题、状态（Accepted / Superseded by）
   - 第三节：其他文档一行一条
   - 删除"29 个 source of truth"的列表写法
6. `docs/plans/PLAN-0001-dual-source-v0.1-implementation.md`：
   - Status 改为 `In Progress — DoD tracked below`
   - 在 "v0.1 Definition of Done" 每一条前加 `- [x]` / `- [ ]`，当前真实状态：

     ```text
     - [x] both white-box and black-box event paths work        （黑盒 compose 已验证；白盒仅 contract test，见 phase12 log）
     - [ ] two node agents can identify themselves ...           （只有单节点 local-dev）
     - [x] no arbitrary shell endpoint exists
     - [x] event/incident/evidence/model-output separation is persisted
     - [ ] OOM and container die scenarios are genuinely tested  （M6）
     - [x] central/model outage is fail-safe ...                 （C 级证据，A 级见 M5）
     - [x] secrets are not committed
     - [x] tests/typecheck pass
     - [ ] deployment artifacts are ready for test-infra
     - [x] README documents how to run agent and node-agent locally
     ```
7. `.gitignore` 追加：

   ```text
   docs/*.visual-check.*
   ```

   **[OWNER]** 决定 `.agents/`、`.claude/`、`skills-lock.json`、`docs/pi-ops-*.html|json` 是提交还是忽略。代理只在报告里列出，不动。

## Acceptance

- `pnpm test:governance` 通过（docs 不在 governed roots，但 validate 必须仍绿）
- `docs/README.md` 不超过 120 行
- `git log --stat` 只含 docs/ 与 .gitignore

## Commit

```text
docs(adr): 记录推理平面收敛并标记被取代的 ADR
```

---

# M2 — 小型加固

## Goal

两处一行改动，不改行为。

## Steps

1. **timingSafeEqual**。在 `packages/protocol` 之外新建一个共享函数不值得（三个 app 各自一个 config），所以每个 app 内各加一个 6 行 helper：

   ```ts
   import { timingSafeEqual } from 'node:crypto';
   export function bearerMatches(header: string | undefined, token: string): boolean {
     const expected = Buffer.from(`Bearer ${token}`);
     const actual = Buffer.from(header ?? '');
     return actual.length === expected.length && timingSafeEqual(actual, expected);
   }
   ```

   替换点：
   - `apps/agent/src/app.ts:70`（ingest）、`:132`、`:160`（runtime token）、`:304`（operator）
   - `apps/pi-runtime/src/app.ts:55`、`:72`
   - `apps/node-agent/src/app.ts:65`

   放在各自的 `app.ts` 顶部即可，不要新建文件。
2. **AbortSignal.timeout**。Node 22 原生支持。逐个文件把"new AbortController + setTimeout(abort) + clearTimeout"替换为 `AbortSignal.timeout(ms)`：

   ```text
   apps/agent/src/evidence-orchestrator.ts
   apps/agent/src/http-pi-runtime-client.ts
   apps/agent/src/notifier.ts
   apps/pi-runtime/src/callback.ts
   apps/node-agent/src/detectors/health.ts
   apps/node-agent/src/events/sender.ts
   apps/node-agent/src/evidence/probe.ts
   ```

   **不改** `apps/pi-runtime/src/deadline.ts` 和 `coordinator.ts`：它们的 AbortController 是编排级 deadline，需要手动 abort，不是简单超时。
   注意：`AbortSignal.timeout` 抛出的是 `TimeoutError`（DOMException name），原代码若判断 `error.name === 'AbortError'` 需同时接受 `'TimeoutError'`。先 grep 每个文件里对 AbortError 的判断再改。
3. 现有 auth-matrix 测试和 transport 测试必须不改即绿。若某测试依赖 fake timer 触发 abort，保留该文件原写法并在报告里说明。

## Acceptance

- `pnpm test` 全绿，测试文件零改动（允许例外见上）
- `plan --strict` READY（这些文件都已在 features.json 的 auth / transport feature 下；若报 UNMAPPED，把路径**追加**到对应 feature，属于 strengthening）

## Commit

```text
fix(auth): 三服务 Bearer 校验改用 timingSafeEqual 并统一超时信号
```

---

# M3 — 删除不可达代码

## Goal

删掉从 `index.ts` 不可达的 `delegated-result-ingestion.ts`。

## Steps

1. 验证不可达（必须在报告里贴结果）：

   ```bash
   grep -rn "delegated-result-ingestion" apps/agent/src --include='*.ts' | grep -v __tests__
   ```

   预期无输出。
2. 按 §0.1 查治理引用：

   ```bash
   grep -n "delegated-result-ingestion" tools/test-governance/config/*.json
   ```

   评审时无命中。若有命中且非 PINNED，连同 catalog 条目删除。
3. `git rm apps/agent/src/delegated-result-ingestion.ts apps/agent/src/__tests__/delegated-result-ingestion.test.ts`
4. 检查 `store.ts` 中只被该文件调用的方法：

   ```bash
   grep -o "store\.[a-zA-Z]*" apps/agent/src/delegated-result-ingestion.ts | sort -u
   ```

   对每个方法 grep 其它调用方；只被删除文件调用的方法一并删除。**不删表，不删列**（现有 SQLite 数据要兼容）。
5. `docs/adr/ADR-0013` 已在 M1 标 Superseded，此处不再动文档。

## Acceptance

- `pnpm typecheck && pnpm test` 绿
- `plan --strict` READY 或仅因 catalog 条目移除需要 validate 通过
- 源码净减少 ≥ 98 行

## Commit

```text
refactor(agent): 删除不可达的 delegated result ingestion
```

---

# M4 — 移除进程内 PiReasoner 路径 **[OWNER]**

## Goal

`apps/agent` 不再直接调用 Pi SDK。`reasonerType` 只剩 `fake`。

## 为什么需要 owner

`reasoning.local` feature 的 paths 包含 `apps/agent/src/pi-reasoner.ts`。删它必须从 features.json 移除该路径，触发 `GOVERNANCE_POLICY_WEAKENING → HUMAN_REQUIRED`。代理准备 PR，owner 在 `governance-review` Environment 审批。

## Steps

1. 删除：

   ```text
   apps/agent/src/pi-reasoner.ts
   apps/agent/src/pi-sdk-client.ts
   apps/agent/src/pi-client.ts
   apps/agent/src/smoke/pi-reasoner.smoke.ts
   apps/agent/src/__tests__/pi-reasoner.test.ts
   ```

   先按 §0.1 逐个 grep 治理引用，把命中列进 PR 描述。
2. `apps/agent/src/config.ts`：`reasonerType` 类型收窄为 `'fake'`；`PI_OPS_REASONER_TYPE=pi` 改为 fail closed 报错 `reasonerType 'pi' removed in ADR-0029; use external Pi Runtime`。删除 `piProvider / piModel / piApiKey / reasoningTimeoutMs / reasoningMaxRetries / reasoningMaxContextBytes / reasoningMaxEvidenceItems / reasoningMaxLogLines / reasoningMaxOutputBytes` 中**只被 PiReasoner 使用**的项（每项先 grep 确认，被 investigation-context 或 runtime 复用的保留）。
3. `apps/agent/src/index.ts`：删除 `if (config.reasonerType === 'pi')` 分支及三个 import。保留 `createFakeReasoner` 与 `createReasonerRegistry`。
4. `apps/agent/src/reasoning-strategy.ts`：`single_reasoner` 分支删除；`ReasoningStrategyName` 收窄。`delegated_analysis` **保留**（外部 runtime 路径仍用它）。
5. `apps/agent/package.json`：若 `@earendil-works/pi-coding-agent` 仅被删除文件引用，移除依赖并 `pnpm install` 更新 lock。
6. README.md "Reasoner selection" 一节改写：只保留 fake 与外部 Runtime 两种模式，删除 `PI_OPS_PI_*` 环境变量段落；`.env.example` 同步。
7. `tools/test-governance/config/features.json`：`reasoning.local.paths` 移除 `pi-reasoner.ts` 与不存在的 `reasoning-service.ts`。
8. `tools/test-governance/config/architecture-guards.json` 追加一条 forbiddenImport guard（strengthening）：

   ```json
   {
     "id": "ARCH-AGENT-NO-MODEL-SDK",
     "description": "Pi-Ops control plane must not call a model SDK directly (ADR-0029).",
     "kind": "forbiddenImport",
     "scope": ["apps/agent/src/**"],
     "patterns": ["@earendil-works/pi-coding-agent", "pi-sdk-client", "pi-reasoner"]
   }
   ```

## Acceptance

- `pnpm typecheck && pnpm test` 绿
- `pnpm test:arch` 绿且包含新 guard
- `plan --strict` 输出 `GOVERNANCE_POLICY_WEAKENING`，且 PR 描述已解释；**[OWNER]** 审批后合并
- `apps/agent/src` 净减少 ≥ 500 行

## Commit

```text
refactor(agent): 移除进程内 PiReasoner，外部 Pi Runtime 成为唯一推理平面
```

---

# M5 — 关闭 3 个 P1 Evidence 缺口

## Goal

`node tools/test-governance/src/cli.mjs gaps` 输出 `MACHINE EVIDENCE GAPS: 0`。

三个缺口都要 A 级证据（真实进程边界），都能在本机 compose 上做。全部落在 `deploy/local/smoke.sh` 或新的 `deploy/local/smoke-<name>.sh`，用 catalog COMMAND 类型登记。COMMAND 只接受 `pnpm <script>` 且脚本内容必须是 `bash <file>`，见治理 README。

## Steps

### 5.1 INV-SAFE-01（成本最低，先做）

1. `deploy/local/drill/server.mjs`：`/fail` 路径触发时额外向 stdout 打一行 `ENV_KEY=drill-super-secret-value SECRET_KEY=drill-secret-2`。
2. `deploy/local/smoke.sh` 第 95-96 行已经断言 safe 视图不含 `super-secret`。补两条：
   - raw 视图 `docker.logs` 证据里**包含** `drill-super-secret-value`
   - safe 视图里不包含它，但包含脱敏占位（查 `apps/agent/src` 里 `toRuntimeSafeEvidence` 的实际占位字符串后写断言）
3. catalog：把 `safe-redact-inspect` 所在 invariant 的 A1 slot 指向 `pnpm smoke:local`。

### 5.2 INV-EVD-02（Node Agent 中途不可达）

1. 新建 `deploy/local/smoke-node-outage.sh`：
   - 启动 compose，触发 drill `/fail`，等到 Incident OPEN
   - `docker compose stop pi-ops-node-agent`
   - 通过 `POST /v1/ops/investigations` 触发一次调查（operator token）
   - 轮询 `GET /v1/ops/incidents/:id/evidence?view=raw`，断言：存在 `status=failed` 且 `failureClass` 为 retryable 的 Evidence；**不存在**任何 `http.probe` Evidence 的 `healthy=false` 是在 node-agent 停止期间 `collectedAt` 的
   - `docker compose start pi-ops-node-agent`，轮询直到该 Incident 出现新的 `succeeded` Evidence
2. `package.json` 加 `"smoke:node-outage": "bash deploy/local/smoke-node-outage.sh"`。
3. catalog 登记为 INV-EVD-02 的 A1。

### 5.3 INV-STALE-01（Runtime ACK 后死亡）

1. 新建 `deploy/local/smoke-runtime-crash.sh`，需要在 compose 里用 env 覆盖 `PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS=15000` 和 `PI_OPS_INVESTIGATION_RETRY_MAX_ATTEMPTS=2`（用 `docker compose --env-file` 叠加文件 `deploy/local/compose.env.stale`，不改默认 env）。
   - 触发 Incident，等 session 进入 SUBMITTED 或 RUNNING（`GET /v1/ops/incidents/:id` 的 sessions 字段）
   - 立即 `docker compose kill pi-runtime`
   - 等待 > 15s，断言第一个 session 为 FAILED 且 `error` 包含 stale
   - `docker compose start pi-runtime`，断言出现第二个 session 且最终 COMPLETED，`reasoning_results` 恰一条属于第二个 session
2. `package.json` 加 `"smoke:runtime-crash"`。
3. catalog 登记为 INV-STALE-01 的 A1。

### 5.4 CI

`.github/workflows/test-governance.yml` 当前是否启动 compose？若否，这三个 smoke 在 CI 中不可执行，catalog 的 `executionClass` 要按治理 README 标为本地执行类，并在 `docs/testing/test-gap-report.md` 注明"A 级证据在本机 compose 实现，CI 不运行"。**[OWNER]** 决定是否在 CI 加 docker compose job（GitHub-hosted runner 支持）。

## Acceptance

- 三个 smoke 脚本本机各跑通两次
- `cli.mjs gaps` 输出 0
- `test:plan` 对 evidence.collection / evidence.model-safe-projection / investigation.reconciliation 不再 NEEDS_EVIDENCE
- `docs/testing/test-gap-report.md` 重新生成并提交

## Commit

分三个 commit，每个缺口一个：

```text
test(smoke): 植入 secret 形态日志证明 raw 保留而 safe 脱敏
test(smoke): Node Agent 中途停止时 Evidence 保持 retryable 且不合成健康状态
test(smoke): Pi Runtime ACK 后崩溃触发 stale 失败与有界重试
```

---

# M6 — S3 OOM / S5 事件洪泛演练

## Goal

PLAN-0001 里 "OOM and container die scenarios are genuinely tested" 打勾。

## Steps

### 6.1 S3 OOM

1. `deploy/local/docker-compose.yml` 加一个 `pi-ops-oom-drill` 服务：`mem_limit: 32m`，镜像用 `node:22-alpine`，command 为分配内存直到被 kill 的一行 node 脚本，`restart: "no"`。默认 `profiles: [oom]`，不影响 `smoke:local`。
2. `deploy/local/smoke-oom.sh`：`docker compose --profile oom up -d pi-ops-oom-drill`，等 node-agent 上报 `docker.die` 且 `exitCode=137` / `OOMKilled=true`（查 `apps/node-agent/src/events/docker-events.ts` 实际字段名），断言 Incident type 为 OOM 相关类型，Evidence 中同时有 `docker.inspect` 与 `host.memory`。
3. 登记 catalog（新 invariant 归到 `node.docker-evidence` 或现有 OOM feature，只加不减）。

### 6.2 S5 事件洪泛

1. `deploy/local/smoke-flood.sh`：用 ingest token 向 `/v1/events` 连发 100 个同 fingerprint 的 EventBatch（fixture 复用 `apps/agent/src/__tests__/fixtures/dataasset-business-error.eventbatch.json`，只改 `time`）。
2. 断言：`GET /v1/ops/incidents` 中该 fingerprint 只有 1 个 Incident；`sessions` ≤ 1；notification-sink 收到的 `INCIDENT_OPEN` 恰 1 条。
3. 登记 catalog。

## Acceptance

- 两个脚本本机跑通
- PLAN-0001 DoD 对应行改 `[x]`

## Commit

```text
test(smoke): 增加 OOM 容器与事件洪泛的本机演练
```

---

# M7 — 诊断质量：结构化输出修复 + benchmark 扩展

## Goal

消除 thinking=high 下 "输出未通过结构化校验" 的失败；benchmark 覆盖不止 CPU 一类。

## 前置

需要 `pnpm smoke:pi` 同款凭证（gitignored）。无凭证时只做 7.1 的代码与 fake 测试，7.2 留给 owner 跑。

## Steps

### 7.1 pi-session 一次修复重试

1. 读 `apps/pi-runtime/src/pi-session.ts` 与 `specialists.ts` 中解析 specialist 输出的位置。
2. 校验失败时，**同一 session** 内追加一条用户消息：`Your previous reply failed schema validation: <zod/validator 错误摘要，≤ 300 字符>. Reply with only the JSON object.` 重试一次。重试仍失败则按现有逻辑标 failed。
3. 重试计入 `inputTokens/outputTokens`，不延长 deadline。
4. `apps/pi-runtime/src/__tests__/` 加一个 fake model 测试：第一次返回非法 JSON、第二次合法 → completed；两次都非法 → failed。
5. 不加 `PI_OPS_*` 配置项，重试次数硬编码 1，代码注释 `// ponytail: one repair retry; make configurable only if benchmark shows a second retry helps`。

### 7.2 benchmark 扩展（需凭证）

1. `apps/pi-runtime/src/benchmark/fixtures.ts` 增加两组 golden case，每组 ≥ 3 个：
   - `oom-*`：容器 OOM vs 主机内存压力归因，Evidence 只用现有 `docker.inspect / docker.stats / host.memory / jfr.signal` 字段
   - `die-*`：container die 退出码 + 日志尾部，区分应用崩溃 / 被外部 kill / 健康检查失败
2. oracle 只做 deterministic hard check，与现有 README 原则一致。
3. 跑 `--mode live`，至少 2 个模型 × 3 档 thinking × 3 轮，输出到 `artifacts/jvm-diagnosis-benchmark/`（已 gitignore）。
4. 在 `apps/pi-runtime/src/benchmark/README.md` 末尾加一张汇总表：模型 × thinking → hard pass 率、P50 延迟、平均 token。原始 md 不入库。

## Acceptance

- 7.1：fake 测试绿；`pnpm benchmark:jvm` fake 模式 hard pass 不低于当前 4/6
- 7.2：README 汇总表填入真实数据；high 档结构化校验失败为 0

## Commit

```text
feat(pi-runtime): specialist 输出校验失败时一次修复重试
feat(benchmark): 增加 OOM 与 container die 场景并记录多模型评测
```

---

# M8 — store.ts 迁移编号化与按域拆文件

## Goal

迁移可审计，`store.ts` 降到 ~1500 行以下。不改表结构，不改任何 SQL 语义。

## Steps

### 8.1 迁移编号化

1. 读 `apps/agent/src/store.ts:1488-1760`，列出所有 `CREATE TABLE` 与 `ALTER TABLE ADD COLUMN`。
2. 新建 `apps/agent/src/store-migrations.ts`：

   ```ts
   export const MIGRATIONS: ReadonlyArray<{ version: number; up: (db: Database) => void }> = [
     { version: 1, up: (db) => { /* 全部 CREATE TABLE IF NOT EXISTS，原样搬 */ } },
     { version: 2, up: (db) => { /* events.schema_version + event_time */ } },
     // ... 每个现有 try/ALTER 块一个 version，顺序按文件中出现顺序
   ];
   export function migrate(db: Database) {
     const current = db.pragma('user_version', { simple: true }) as number;
     for (const m of MIGRATIONS) if (m.version > current) db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); })();
   }
   ```

3. **兼容既有库**：现有 SQLite 文件 `user_version` 为 0 但列已存在。所以每个 `up` 内的 ADD COLUMN 保持现在的"先查 `PRAGMA table_info` 再 ALTER"写法，幂等。CREATE 用 IF NOT EXISTS。第一次在旧库上跑会把全部 version 走一遍，全部 no-op，最后 user_version 到位。
4. `reasoning_jobs` 的 UNIQUE 重建（1488-1505）和 `reasoning_results` fail-closed 检查（ADR-0025）原样保留在对应 version 内，**不改语义**。
5. 现有 `reasoning-jobs-migration.test.ts` 与 `reasoning-results-migration.test.ts` 不改即绿。另加一个测试：对 `deploy/local/data/pi-ops/pi-ops.sqlite` 的副本（若存在）打开一次，断言 `user_version === MIGRATIONS.at(-1).version` 且不抛。

### 8.2 按域拆文件

只拆两组自包含的表族，其它不动：

| 新文件 | 从 store.ts 迁出的方法 | 表 |
|--------|----------------------|-----|
| `store-memory.ts` | 所有 `*MemoryCandidate*`、`*MemoryEntry*`、`*MemoryFeedback*` | memory_candidates, memory_entries, memory_feedbacks |
| `store-investigation-graph.ts` | `*InvestigationRelation*`、`*InvestigationHypothesis*`、`*EvidenceProfile*`、`*InvestigationQualityEvaluation*` | investigation_relations, investigation_hypotheses, evidence_profiles, investigation_quality_evaluations |

方式：每个新文件导出 `createMemoryStore(db: Database)` 返回原方法对象；`createEventStore` 内 `return { ...core, ...createMemoryStore(db), ...createInvestigationGraphStore(db) }`。**公共接口 `EventStore` 类型不变**，调用方零改动。prepared statement 在各自工厂内准备。

不引入 repository 基类、不引入 ORM。

## Acceptance

- `pnpm test` 全绿，`__tests__` 目录零改动（新增测试除外）
- `store.ts` ≤ 1800 行
- 对 `deploy/local/data/pi-ops/pi-ops.sqlite` 的副本执行 `pnpm smoke:local` 前后数据不丢

## Commit

```text
refactor(agent): SQLite 迁移改为 user_version 编号序列
refactor(agent): 按 memory 与 investigation graph 拆分 store
```

---

# M9 — Memory 子系统去留 **[OWNER]**

## 现状

candidate 会写入（`reasoning-evaluation.ts:103`），但 approve / reject / feedback 没有任何生产调用方。retriever 永远返回空。ADR-0006、0009、0010、0016、0017、0024 描述的历史知识链路运行时不存在。

## 决策输入

等 M7 benchmark 数据：如果没有历史知识注入时诊断 hard pass 已经稳定 ≥ 90%，说明 Memory 不是当前瓶颈。

## 选项 A：接通（约 2 天）

1. `apps/agent/src/app.ts` 加 operator 路由：
   - `GET  /v1/ops/memory/candidates?status=PENDING`
   - `POST /v1/ops/memory/candidates/:id/approve`
   - `POST /v1/ops/memory/candidates/:id/reject`
   - `POST /v1/ops/memory/entries/:id/feedback` body `{ incidentId, outcome }`
2. 全部 operator token；全部走现有 `memory-governance.ts` / `memory-feedback.ts`，不加逻辑。
3. `smoke.sh` 追加：approve 一个 candidate → 再触发一次同类 Incident → 断言 `historicalKnowledgeStatus=available` 且 report 引用了 memory。
4. features.json 加 paths（strengthening）。

## 选项 B：冻结

1. ADR-0029 或新 ADR-0030 标注 memory 相关 ADR 为 `Dormant`：代码保留，不新增功能，不算入 DoD。
2. `docs/README.md` 的 ADR 索引里状态列写 Dormant。
3. 零代码改动。

## 选项 C：删除（触发 HUMAN_REQUIRED）

删除 memory-*.ts、investigation-knowledge.ts、incident-similarity.ts、对应测试、features.json 的 `memory.retrieval` / `memory.governance`，表保留。同 M4 流程。

**代理默认执行 B**，除非 owner 明确选 A 或 C。

---

# M10 — 治理工具瘦身 **[OWNER]**

## 现状

| 项 | 行数 |
|----|------|
| `tools/test-governance/src/*.mjs` + `trust-anchor/*.mjs` | 8187 |
| `config/catalog.json` | 1595 |
| `config/features.json` | 951 |
| 三服务 + protocol 源码合计 | ~11000 |

CONTRIBUTING.md 把 Trust Anchor 定为 non-negotiable，所以本里程碑**只产出方案，不执行**，由 owner 拍板后另立 PLAN。

## 建议方案（供 owner 选择）

**保留**：`architecture-guards.json` + `test:arch`（75 行配置，价值高）；`test:run` 真实执行测试；Evidence A/B/C 的概念。

**建议替换**：
1. `pull_request_target` 双 workflow 信任锚 → GitHub 原生 branch protection required check + CODEOWNERS。理由：同仓库、1-2 人、无外部贡献者，`pull_request_target` 的威胁模型不成立，而它带来的 bootstrap PR、BASE checkout、HUMAN_REQUIRED Environment 三层复杂度是当前最常出 bug 的地方（近 30 次提交里 8 次在修它）。
2. `catalog.json` 手工登记 → 停止增长。新测试不再要求登记；floor 只对 PINNED 与 A 级 smoke 保留。
3. Policy Delta Guard → 保留但降级为 warning 而非 fail closed（把 `GOVERNANCE_POLICY_WEAKENING` 改成 `HUMAN_REQUIRED` 之下的 review 提示）。

**预期效果**：治理代码减半，`test:governance` 从 4 步降到 2 步，删除遗留代码不再需要 Environment 审批。

## 产出

`docs/plans/PLAN-0003-governance-slimming.md` 草案，含上述三项各自的删除文件清单与保留清单。owner 批准后再执行。

---

## 3. 里程碑完成报告模板

```text
## M<n> 完成报告
- 分支 / PR：
- 改动文件：
- 决策与偏离计划之处：
- 验证：
  pnpm typecheck        -> ok / fail
  pnpm test             -> <n> pass / <m> fail
  pnpm test:governance  -> ok / fail
  plan --strict         -> READY / <state>
- 治理引用检查（§0.1）：无命中 / 命中列表
- 遗留与下一步：
- 需要 OWNER 决策的项：
```
