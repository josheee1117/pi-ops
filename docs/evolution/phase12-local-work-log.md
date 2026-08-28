# Phase 12 本机做了什么、验证了什么

这是操作与验收记录，不是 ADR。架构仍以 ADR-0001 / ADR-0025 为准。

GitHub 上能复现的是代码、单测和脚本。本机实跑的 incident / SQLite / 模型日志 **没有** 进仓库（密钥和运行数据不应入库）。

## 提交（已 push `origin/main`）

| commit | 内容 |
|--------|------|
| `daa943f` | `pnpm smoke:pi`：缺 `PI_OPS_PI_PROVIDER` / `PI_OPS_PI_MODEL` 失败；禁止 FakeRuntimeModel 回退；真实模型 JSON 容错 |
| `bdaf1b7` | Node Agent 允许 `data-asset-dev-jdk17`；健康检查 `http://host.docker.internal:18089/actuator/health` |
| `b3898c1` | 修假成功：`http.probe` 连不上记成 `healthy: false` 的有效 Evidence，evidence job 完成并自动开调查；coordinator 把字符串 id 收成数组 |

相关单测：`apps/agent/src/__tests__/evidence-orchestrator.test.ts`、`evidence-worker.test.ts`。当时 `pnpm --filter @pi-ops/agent test` 303 pass。

## 只在本机做、未入库

- RAGFlow 本地 compose（项目名 `ragflow-local`）：Web `http://127.0.0.1:18086/`。overlay 在 ragflow 仓库未跟踪文件 `docker/docker-compose.local-piops.yml`，**不是** pi-ops 仓库的一部分。
- DataAsset `dev_jdk17` worktree：`/Users/hejiayuan/code/data-asset-dev-jdk17`；镜像 `data-asset:dev-jdk17`；容器 `data-asset-dev-jdk17` 映射 `18089:8089`。Dockerfile/jar 在 `/Users/hejiayuan/code_me/local-apps/data-asset/`，**不在** pi-ops Git。
- 关掉本机另一个 DataAsset 进程（原 `8089` jar）。Docker 实例保留。
- 真实模型跑在宿主机 `:18091`，密钥只在 gitignored `deploy/local/.env`。
- 故障注入：`docker pause data-asset-dev-jdk17`，事后 `docker unpause`。没有写 PolarDB，没有走 Pi-Ops remediation。

## 验证过（有运行证据）

### 1. 真实模型门禁（对象是 drill，不是 DataAsset）

`pnpm smoke:pi` 曾 structural PASS：provider `cpa`，model `deepseek-v4-flash-huoshan`，`modelMode=REAL`，有 `host.memory` enrichment。工作负载是 `pi-ops-drill`。

### 2. DataAsset 第一次（假成功，不要当验收）

Incident `inc-e46ecab6-a06b-48a9-a2cc-fc1993d29a6b`：probe 超时导致 evidence job 不完成。调查是手动 `POST /v1/ops/investigations` 才出来的。结论（容器 paused）对，路径不算自动验收。

### 3. 修 bug 后自动路径（DataAsset 算过的那一次）

- Incident：`inc-9ae5c6ae-6eda-4628-b505-b55668fc6d8d`（随后 RECOVERED）
- Session：`isess-6d1dcfb9-9f57-47f3-a49c-07cf02109c7c` **COMPLETED**
- 自动提交（Pi-Ops 日志，不是手动 POST）：`investigation submitted session=isess-6d1dcfb9-... incident=inc-9ae5c6ae-...`
- Evidence：`docker.inspect` / `docker.logs` / `http.probe` 均为 succeeded
- 模型：REAL `cpa` / `deepseek-v4-flash-huoshan`，`calls=2`
- 报告要点：容器 paused → actuator probe timeout；xxl-job DNS 是噪声

中间一枪 `inc-111aa755-4acf-4fd1-a599-e57cc5a1abee` 已自动提交但 coordinator JSON 失败，随后才有第 3 条。

## 没有验证、不能从 GitHub 声称通过

- DataAsset 慢 SQL / 内存压力 / 业务错误（不是 pause）
- RAGFlow 事故调查
- DataAsset JFR 白盒
- Phase 12B、远程、remediation、shell
- `pnpm smoke:pi` **没有**改成打 DataAsset，它仍打 drill

## 本机如何复核（数据还在本机 SQLite 时）

```bash
curl -sS -H 'Authorization: Bearer local-ingest-token' \
  http://127.0.0.1:18080/v1/ops/incidents/inc-9ae5c6ae-6eda-4628-b505-b55668fc6d8d

docker logs pi-ops-local-pi-ops-1 2>&1 | rg 'inc-9ae5c6ae'

curl -sS http://127.0.0.1:18081/health
# allowedContainers 应含 data-asset-dev-jdk17
```

换机器或清掉 `deploy/local/data/` 之后，GitHub **不能**单独复现那次 incident；只能复现代码路径和单测。
