# 首批执行规格：B01、B02 和 S06

状态：准备记录。不是开测批准，不是场景 PASS。

本文件绑定事实、当前合同和缺口。用户已选择通知方案一，并允许独立补 DataAsset 与 Starter 的非预期请求异常事件源。方向见 [ADR-0030](../adr/ADR-0030-fault-notification-policy.md)，实现细节及 offline literal 断言见 [PLAN-0003](../plans/PLAN-0003-fault-notification-policy.md)。本波不改中央生产策略或协议。新方向未实现，不能把旧合同快照当作新策略通过。

旧 Java Drill 不是 DataAsset。`deploy/local/jdk17-drill` 的 `/fail` 和 `OrderFailure` 只能当作已有机制对照，不能改名后充当本批接入证据，也不能用来重评分旧报告。

## 判定词

结果使用 `PASS`、`FAIL`、`GAP`、`BLOCKED` 和 `NOT_RUN`。

- 前提缺失记 `BLOCKED`。目标、账号、预算、同意和安全故障开关都还没有。
- 能力未实现记 `GAP`。
- 这次没有调用的模型和没有发送的消息记 `NOT_RUN`。
- 产品方向不再 `policy BLOCKED`，中央实现差距记 `policy GAP`。下文历史离线输出的 `policy BLOCKED` 保留原评分，不表示还需批准相同方向。
- 离线检查的 exit 0 只表示内存合同快照仍匹配。它不是 B01、B02 或 S06 的场景 `PASS`。

观测事实、推断、未测和前提缺失分开写。下面没有写到的远端镜像 tag、测试账号、调用预算和同意，都是未知，不补造。

## 离线检查

命令，在 `apps/agent` 下运行：

```text
./node_modules/.bin/tsx src/__tests__/first-batch-offline.check.ts
```

文件名不是 `*.test.ts`。`apps/agent/package.json` 的 `test` 只加载 `src/**/*.test.ts`，所以默认全量测试不会运行它。不要把该文件改成 `*.test.ts`，也不要把它加进默认 `test` 脚本。

检查使用 `makeAgentConfig`、`:memory:` SQLite、`app.request` 和 `FakeNotifier`。它不启动 Evidence worker，不探测 URL，不调用模型，不发送 webhook。合成事件和 golden fixture 只证明中央接收合同。它们不是 DataAsset 发送器证据。

exit 0 的含义写在检查输出的 `exitMeaning`。有合同不符时 exit 非 0，并在 `mismatches` 列出观测值和合同值。不能把 exit 0 当成场景通过。

这次准备运行测到的中央合同：

- 空库的 Event、Incident、Evidence 和 pending recovery 都是 0。
- 一条合成的 `business.error` 被接受，生成 1 个 `OPEN` Incident 和 1 个 `INCIDENT_OPEN`。没有 `containerName` 时证据计划是空数组。Evidence 记录数是 0。
- golden `business.error` fixture 被接受。同 `businessCode` 与 `module` 在 60 秒后仍进同一 Incident。聚合窗从该 Incident 的 `last_seen` 起算，不是从首条事件起算。下一条要在 `last_seen` 之后超过 `aggregationWindowMs` 才新建 Incident。这次用的窗是 `makeAgentConfig` 的 300000 毫秒。
- `RECOVERY_TYPE_MAP` 没有指向 `business.error` 的项。臆造类型 `business.error_recovered` 新开了一个 `OPEN` Incident，没有关闭任何 Incident，pending recovery 仍是 0。
- 同一 `health.failure` episode 内，10 秒间隔的 3 条失败仍是 1 个 Incident。随后的 `health.recovered` 把它变成 `RECOVERED`，任务恰好是 `INCIDENT_OPEN` 和 `INCIDENT_RECOVERED`。重放同一事件 id 不新增任务。`FakeNotifier` 收到的顺序是 `INCIDENT_OPEN` 然后 `INCIDENT_RECOVERED`，两条状态都是 `DELIVERED`。证据任务保持 `PENDING`，Evidence 记录数是 0。计划类型是 `http.probe`、`docker.inspect`、`docker.logs`。探测 URL 没有被请求。
- 一条合成 `health.failure` 之后不再注入失败，恢复事件时间比失败晚 360000 毫秒。同一个 Incident 变为 `RECOVERED`，任务是一条 `INCIDENT_OPEN` 和一条 `INCIDENT_RECOVERED`，pending recovery 是 0，没有额外建单。这个时间差是合成事件时间，不是测到的真实故障持续时长。
- 两条合成 `health.failure` 相隔 360000 毫秒，是中央输入边界，不是检测器输出。结果是 2 个仍为 `OPEN` 的 Incident。随后的 `health.recovered` 因多个候选 fail closed，`reconcilePendingRecoveries()` 之后 pending recovery 仍是 1，没有 `INCIDENT_RECOVERED`。第二条失败事件的真实触发条件未测。不能从该结果推断普通持续故障必然重复建单。

检查进程自己的分阶段判定不是场景判定。B01 和 S06 的发现是 `BLOCKED`。B02 的发现和收证在检查里是 `NOT_RUN`，因为进程没有运行 DataAsset。B02 恢复是 `GAP`，这是检查直接测到的映射缺失。当时三个场景的通知都是 `policy BLOCKED`。这是历史输出，不重评分；现在方向已批准而代码未实现，后续准备状态是 `policy GAP`。没有任何阶段是场景 `PASS`。

## 已核对的绑定事实

制品与源码：

- 本地制品路径是 `/Users/hejiayuan/code_me/local-apps/data-asset/data-asset-starter-0.0.1-SNAPSHOT.jar`。大小 149137476 字节。sha256 是 `44cfd0cbf522c8ab4c8a4ca79dedbe36cc0b86e5aafb946d070e3ddb9275701c`。包内有 `BOOT-INF/lib/pi-ops-jfr17-spring-0.0.1-SNAPSHOT.jar` 和 `BOOT-INF/lib/pi-ops-jfr-events-0.0.1-SNAPSHOT.jar`。
- 发送器类在嵌套 jar 中，包括 `PiOpsTransportConfig`、`PiOpsEventSender` 和 `JfrRecordingStreamLifecycle`。
- DataAsset 当前检出是 `feature-20261008-maxcompute`，短提交 `9ee2823f`。`git ls-tree HEAD` 对 `pi-ops-jfr17-spring` 和 `pi-ops-jfr-events` 为空。工作树里的 `pi-ops-jfr17-spring/target` 只是残留目录，不是源码。从当前检出构建不会带上这些模块。
- 发送器源码在分支 `dev_jdk17`，提交 `4d9b4cf9fd423e5f900c4b1b69e32f083fc2b59c`。该提交与本地 jar 是否同一次构建尚未证明。证据限制见 `artifacts/first-batch-dataasset-source-evidence.txt`。`PLAN-0002` 第 468 行写的「DataAsset 仓库不在本机」与本次本地检出不符。本文件不改那份计划。

发送器开关，来自 `dev_jdk17` 的 `PiOpsTransportConfig.java`：

- 第 67 行，`PI_OPS_ENABLED` 缺省是 false。
- 第 77 到 80 行，即使 enabled，缺少 `PI_OPS_AGENT_URL` 或 `PI_OPS_INGEST_TOKEN` 也会把发送关掉。
- 第 148 到 149 行，发送地址是 `<agentUrl>/v1/events`。
- 第 70 行，`PI_OPS_NODE_ID` 缺省是 `default`。第 76 行读取 `PI_OPS_CONTAINER_NAME`。
- `PiOpsJfrAutoConfiguration.java` 第 24 行，`pi-ops.jfr.enabled` 缺省 true。第 46 到 47 行，`slow-sql-enabled` 缺省 true。这只表示 JFR 自动配置可以启动，不表示 HTTP 发送器已开。

公共部署描述没有打开发送器：

- `test-infra/apps/dataasset/compose.yml` 第 4 行容器名是 `dataasset`，第 9 到 10 行宿主端口缺省 8089。该文件的 environment 块没有 `PI_OPS_*`。公开 compose 或示例文件缺少这些键，不能推出实际运行 Env 一定缺失。
- `test-infra/apps/dataasset/.env.example` 中 `PI_OPS_` 出现 0 次。该示例文件里的凭据字段不要抄进批次记录，也不要在记录里复述值。
- `deploy.sh` 第 51 行健康 URL 是 `http://127.0.0.1:${HOST_PORT}/actuator/health`。这只证明部署脚本使用该路径，不证明当前远端健康状态。

事件映射，来自同一 `dev_jdk17` 提交：

- `JfrEventNames.java` 第 10 到 16 行有 `jdk.CPULoad`、`jdk.GarbageCollection`、`jdk.JavaMonitorEnter`、SlowSql 和 BusinessError。没有 `jdk.JavaErrorThrow`。
- `JfrRecordingStreamLifecycle.java` 第 24 到 28 行和第 132 到 146 行只启用上述基线，再按开关启用 SlowSql 和 BusinessError。
- `PiOpsEventMapper.java` 第 82 到 93 行把本地 `BUSINESS_ERROR` 映射为 `business.error`。未识别类型返回 null，不发送。
- 在 `dev_jdk17` 的 `pi-ops-jfr17-spring` 与 `pi-ops-jfr-events` 源码中搜索 `JavaErrorThrow`，没有命中。搜索范围不是整个 DataAsset 仓库。
- 制品里 `BusinessErrorRecorder` 出现在 `AsyncTaskWorkerService.class` 和 `VersionSagaRetryJob.class`。这是业务埋点引用，不是 B01 或 B02 的未处理异常路径。本次没有把它们改名为 DataAsset 演练接口。

中央合同，来自本仓库当前代码：

- `apps/agent/src/fingerprint.ts` 第 3 到 8 行，恢复映射只有 `health.recovered`、`host.memory_recovered`、`host.disk_recovered` 和 `application.slow_sql_recovered`。
- 同文件第 33 到 40 行，`business.error` 指纹只用 `businessCode` 或 `errorCode`，加上可选 `module`。时间和 message 不进指纹。
- `apps/agent/src/store.ts` 第 2549 到 2590 行，新的非恢复事件只在 `aggregationWindowMs` 距离内并入已有 Incident。距离按 `last_seen` 或 `first_seen` 计算。
- 同文件第 2534 到 2547 行，单一活跃候选的恢复不使用聚合窗。多个仍活跃的同指纹候选使 `findRecoveryIncident` 返回 undefined。
- `apps/node-agent/src/detectors/health.ts` 第 63 到 89 行只在 `pressure` 或 `recovery` 转换时发事件。`hysteresis.ts` 第 30 到 43 行在持续失败期间返回 null，不发周期 failure。
- 同文件第 3411 到 3434 行，真正的恢复转换写一条 `INCIDENT_RECOVERED`。
- `apps/agent/src/evidence-orchestrator.ts` 第 146 到 149 行，`business.error` 没有 `containerName` 时计划为空。有容器名时计划 `docker.inspect` 和 `docker.logs`。
- 同文件第 151 到 175 行，`health.failure` 在 `source=health` 且 `detector=http.health` 并带 URL 时计划 `http.probe`，有 `containerName` 时再加 `docker.inspect` 和 `docker.logs`。
- 同文件第 358 到 359 行，Evidence 的 `nodeId` 必须等于 Incident 的 `node_id`，否则收集失败。事件 `nodeId` 因此必须等于 node-agent 的 `nodeId`。
- `apps/node-agent/src/index.ts` 第 16 到 18 行只启动 memory、disk 和 health 检测器。没有日志检测器。

未测，不能从上面推断：

- 没有做 Docker、SSH、远端 HTTP 或部署。`test-svc-02` 当前镜像 tag 是否含发送器，未知。
- 没有读取私有 `.env`、Nacos 配置或 ACR 镜像。
- 没有确认本地镜像已经构建。
- 没有找到可直接引用的本地 DataAsset 运行记录。`deploy/local/data/` 未在本次当作运行证据。

## 配置来源

这些值都已在文件里看到。它们不是本批已经批准的场景阈值。场景 T、W、R、采样间隔和调用超时仍是 `BLOCKED`。

| 来源 | 已看到的值 | 不能当成什么 |
| --- | --- | --- |
| `apps/agent/src/config.ts` 第 185 行 | `PI_OPS_AGGREGATION_WINDOW_MS` 缺省 300000 | 不是已批准的故障窗 W |
| `apps/agent/src/__tests__/test-config.ts` | 离线检查使用同一个 300000 | 不是产品现场配置 |
| `apps/agent/src/config.ts` 第 259 行 | 通知 `maxAttempts` 缺省 5 | 不是外部消息预算 |
| `apps/node-agent/src/config.ts` 第 236 行 | `PI_OPS_HEALTH_FAILURE_DURATION` 缺省 2 | 不是已批准的 S06 触发样本数 |
| 同文件第 223 行 | `PI_OPS_DETECTOR_POLL_INTERVAL_MS` 缺省 10000 | 不是已批准的采样间隔 |
| 同文件第 199 行 | `PI_OPS_PROBE_MAX_TIMEOUT_MS` 缺省 30000 | 不是已批准的调用超时 |
| `deploy/local/compose.env` 第 4 行 | `PI_OPS_NODE_ID=local-dev` | 不是远端 nodeId，也不是 fixture 的 `test-svc-02` |
| 同文件第 27 到 28 行 | duration 1，intervalMs 2000，目标是 `pi-ops-drill` | 本地校准，不是产品缺省 |
| `deploy/local/compose.env.dataasset` 第 3 到 4 行 | allowlist 增加 `data-asset-dev-jdk17`。健康目标名 `data-asset`，URL `http://host.docker.internal:18089/actuator/health`，容器 `data-asset-dev-jdk17`，intervalMs 2000 | 只是 opt-in 覆盖。没有证明应用已启动，也没有注入 `PI_OPS_ENABLED` |
| `deploy/local/docker-compose.fault-drills.yml` 第 25 到 27 行 | duration 2，poll 10000，`FAULT_HEALTH_TARGETS` 必填 | 演练覆盖，不是 DataAsset 绑定 |
| golden fixture | `nodeId` 是 `test-svc-02`，`containerName` 是 `data-asset` | 接收合同样本，不是某个环境的已确认容器名 |

容器名目前对不上。本地覆盖用 `data-asset-dev-jdk17`，远端 compose 用 `dataasset`，fixture 用 `data-asset`。执行前必须选定一个环境并让事件 `nodeId`、`containerName`、allowlist 和健康目标一致。未选定前这三项都是 `BLOCKED`。

本批不新增 `deploy/local` 覆盖，也不把 token 写入仓库。`PI_OPS_ENABLED`、`PI_OPS_AGENT_URL`、`PI_OPS_INGEST_TOKEN`、`PI_OPS_NODE_ID` 和 `PI_OPS_CONTAINER_NAME` 的注入位置未批准。

## 策略差异与本次批准

Accepted ADR-0027 第 26 到 28 行：每个 Incident 一条 `INCIDENT_OPEN`，每个 InvestigationSession 一条 `INVESTIGATION_COMPLETED`，每次真实恢复一条 `INCIDENT_RECOVERED`。代码按这个合同无条件排程。

用户已批准 `docs/testing/real-scenario-validation.md` 的通知产品方向：预期拒绝、单次普通 ERROR 和短暂峰值不发故障告警。同一故障持续时更新原 Incident，不重复首次告警。调查完成默认只留记录。已告警的故障恢复时发一次恢复消息。

差异是推断加本次观测。中央对每个新 Incident 都排 `INCIDENT_OPEN`。已经进入中央的同指纹非恢复事件，若离 `last_seen` 超过聚合窗，会新建 Incident 并再排一条 `INCIDENT_OPEN`。健康检测器在持续失败期间不发周期 failure，所以不能把这条合成边界当成普通持续故障必然重复建单。`INVESTIGATION_COMPLETED` 仍按普通通知投递。本波不改协议或中央通知代码。后续按已批准方向验证，未实现处记 `policy GAP`；旧离线快照不重评分。三个场景的真实执行仍未授权。

## B01

以下 B01/B02/S06 表格保留前次准备评分；其中「accepted 预期」指 ADR-0027 旧实现，「草案预期」现在是已批准方向，`policy BLOCKED` 是历史值。新实现验收另按 PLAN-0003，不覆盖历史结果。

正例：同一接口的合法成功请求。预期是 Starter 不发送故障事件，中央不新建故障 Incident，不发送 `INCIDENT_RECOVERED`。

对照：同一接口的预期拒绝。已看到的候选，都在 `dev_jdk17`：

- 缺少 Authorization Bearer token 时，`AuthFilter.java` 第 102 到 113 行抛出缺失认证头。第 92 行把认证失败写成 HTTP 401。
- `DictController.java` 第 47 到 48 行，`POST /api/dict/types/create` 使用 `@Validated(ValidationGroups.Add.class)`。校验失败由 `GlobalExceptionHandler.java` 第 48 到 56 行记 warn 并返回 400。
- `NoRepeatSubmitAspect.java` 第 51 到 53 行，重复提交抛出 `REPEAT_SUBMIT`。
- `GlobalExceptionHandler.java` 第 32 到 39 行，`BusinessException` 记 warn 并返回 HTTP 200 加业务码。

这些候选是否被 owner 接受为「预期业务拒绝」，还是 `BLOCKED`。测试账号的获取方式也是 `BLOCKED`。凭据不进仓库。

已知配置：不需要故障阈值。发送器开关和节点名见上节。中央没有预期拒绝过滤器。

证据与验收：

- 接入验收必须看到真实发送器没有发出这些拒绝。手工 POST、合成 `business.error` 和测试桩不能当接入证据。
- 离线检查已观测：一条没有 `containerName` 的合成 `business.error` 仍被接受，并生成 `OPEN` 与 `INCIDENT_OPEN`。所以「不误报」目前只是「发送器没发」，不是中央识别后忽略。
- 成功请求的响应、traceId 和请求计数都还没有。业务影响字段是 `BLOCKED`。

故障与停止边界：不要为了制造 401、400 或重复提交去调用真实接口，除非另行授权。不要停依赖，不要改日志文本冒充业务状态。若发送器意外发出事件，停止并把该事件当观测事实保留，不要调低阈值后重评分。

缺失：目标环境、测试账号、是否接受上述三个拒绝作为对照、`PI_OPS_*` 注入位置、调用预算。模型调用和外部消息都是 `NOT_RUN`。

| 项 | 值 |
| --- | --- |
| 场景 | B01 |
| 真实绑定 | missing |
| accepted 预期 | 每个新 Incident 一条 `INCIDENT_OPEN`。没有预期拒绝过滤器。 |
| 草案预期 | 预期拒绝留记录，不发故障告警。没有故障 Incident 时不发 `INCIDENT_RECOVERED`。 |
| 观测事实 | 合成事件被中央接受并建单。真实请求未跑。 |
| 发现 | `BLOCKED` |
| 收证 | `NOT_RUN` |
| 诊断 | `NOT_RUN` |
| 通知 | `policy BLOCKED` |
| 恢复 | `BLOCKED` |

## B02

正例：普通请求发生真实未处理异常。分别记录单次和同一抛出点的持续失败。预期信号应来自真实 Starter 或应用发送器，并带实际异常类、栈、请求状态、失败次数和总请求数。health 保持正常，不能用健康失败代替业务发现。

对照：同一接口的成功请求不产生该故障事件。两个独立业务操作若要分开，必须有不同 `businessCode` 或 `module`。当前指纹不能再按请求对象拆开。这与设计里「相似错误码但故障对象不同不应合并」的要求可能冲突。冲突点是推断，尚未用真实双操作验证，记为未测。

已知配置：不需要单独的 CPU 或 health 阈值。聚合窗来源见上表，场景 W 仍是 `BLOCKED`。同一抛出点必须先锁定同一个 `businessCode` 和 `module`。真实未处理异常目前没有这组字段，因为没有发现路径。

证据与验收：

- 发现路径缺失。`GlobalExceptionHandler.java` 第 66 到 78 行对未捕获异常记 `log.error` 并返回 500。Starter 不订阅 `jdk.JavaErrorThrow`，也没有 ERROR Appender。node-agent 没有日志检测器。这是 `GAP`。
- golden fixture 和既有 `dataasset-contract`、`dataasset-transport` 测试只证明接收合同。fixture 没有 `exceptionClass`。它们不是接入 `PASS`。
- 离线检查测到：窗内重复合并，超出 `last_seen` 加聚合窗后新建 Incident 并再排 `INCIDENT_OPEN`。恢复映射缺失，臆造恢复类型只会再开 Incident。恢复阶段是 `GAP`。

故障与停止边界：本波已允许应用 owner 在 supervisor 指定的独立源码工作区补 DataAsset 与 Starter 的未处理异常事件源，并独立编译、离线验证。不得修改或 checkout `/Users/hejiayuan/code/data-asset` 的 dirty 主工作区。应用源实现结果需另附证据，本文先前源码缺口不是修改后的观测。不要用 jdk17-drill 的 `OrderFailure` 代替。不要手工 POST 一条 500 事件当作应用已经接入。若后续授权运行，health 必须保持成功。health 失败时停止，不能把该 run 记成 B02 发现。

缺失：真实抛出点、异常类、测试账号、成功与失败请求数、触发窗 W、恢复窗 R、调用预算。单次和持续的告警方向已批准，中央实现为 `policy GAP`。模型与外部消息是 `NOT_RUN`。

| 项 | 值 |
| --- | --- |
| 场景 | B02 |
| 真实绑定 | missing |
| accepted 预期 | 收到 `business.error` 就建 Incident。恢复必须有映射。`business.error` 没有映射。 |
| 草案预期 | 单次普通异常留记录。同一抛出点持续失败时更新原 Incident，不重复首次告警。恢复要同路径成功并过恢复窗。 |
| 观测事实 | 发送器源码没有未处理异常路径。中央会接收 `business.error`，窗外重复会新建 Incident，臆造恢复类型不会关闭原 Incident。 |
| 发现 | `GAP` |
| 收证 | `GAP` |
| 诊断 | `NOT_RUN` |
| 通知 | `policy BLOCKED` |
| 恢复 | `GAP` |

规格里的发现和收证 `GAP` 来自 Starter 源码与缺失字段。离线检查进程没有重新测量 Java，所以它自己的发现和收证判定是 `NOT_RUN`。两边不要混成一次场景 `PASS`。

## S06

正例：已配置的健康目标持续失败到已批准的连续样本，再持续成功到已批准的恢复样本。预期是同目标、同 episode 不重复建单，原 Incident 变为 `RECOVERED`，已告警时一条恢复消息。

对照：一次短于触发样本数的失败。产品缺省 duration 是 2。`apps/node-agent/src/__tests__/detectors.test.ts` 已有「一次失败不发事件」和「连续失败只发一条、恢复只发一条」的检测器测试。那是检测器合同，不是 DataAsset 目标的场景 `PASS`。本地 `compose.env` 的 duration 1 不能拿来当这个对照的产品缺省。

已知配置：健康 URL 候选是 `GET /actuator/health`。`AuthFilter.java` 第 44 行把 `/actuator` 放进忽略列表。`deploy.sh` 第 51 行使用同一路径。本地 opt-in 目标、间隔和 duration 见上表。场景采用哪一套 T、W、R，未批准，记 `BLOCKED`。

证据与验收：

- 真实正例需要该目标实际返回 503 或不可达，然后恢复。应用没有 `/fail` 一类开关。health 聚合 DB 和 Redis。离线不能判断当前依赖状态。
- 中央离线合同已测到：单 episode 内合并并可由 `health.recovered` 关闭。证据计划含 `http.probe`、`docker.inspect` 和 `docker.logs`。本次没有执行这些查询，Evidence 记录数是 0，所以收证是 `NOT_RUN`。
- 健康检测器只在状态转换时发送 failure 或 recovery。持续失败没有周期 failure。单一活跃候选的恢复不受聚合窗限制。离线检查用一条合成 failure 和一条晚 360000 毫秒的合成 recovery 覆盖了这条中央路径。事件时间间隔不是测到的真实故障持续时长。
- 两条超窗 failure 只是中央合成输入。它的真实触发条件未测，结果不是 PASS，也不要求补发手工事件。不能从该结果推断普通持续故障必然重复建单。不要在失败后调低聚合窗再沿用原评分。

故障与停止边界：不要停共享 DB、Redis 或容器来制造 503。不要给应用加测试健康开关。两者都超出本批授权。不要把 jdk17-drill 的 `/fail` 结果改名为 DataAsset S06。探测、Docker 和外部通知都未授权。基础设施失败时停止。

缺失：选定的目标环境、容器名、nodeId、采用哪套 duration 和 interval、恢复样本数、最大 run 数、模型调用数和外部消息数。真实 503 与恢复是 `NOT_RUN`。通知方向已批准，中央实现为 `policy GAP`。

| 项 | 值 |
| --- | --- |
| 场景 | S06 |
| 真实绑定 | missing |
| accepted 预期 | `health.recovered` 映射到 `health.failure`。一个活跃候选可以恢复。多个活跃候选 fail closed。 |
| 草案预期 | 持续 503 告警一次，不重复建单。同目标连续成功后关闭原 Incident，并发送一次恢复消息。一次瞬态失败不告警。 |
| 观测事实 | 入口和检测器存在。没有安全制造 503 的手段。一条合成 failure 在超过聚合窗后仍可由同目标 recovery 关闭。两条合成超窗 failure 会使恢复悬挂，那不是检测器的持续失败输出。真实 503 未跑。 |
| 发现 | `BLOCKED` |
| 收证 | `NOT_RUN` |
| 诊断 | `NOT_RUN` |
| 通知 | `policy BLOCKED` |
| 恢复 | `BLOCKED` |

## 共同缺失的目标与预算

以下执行项仍是 `BLOCKED`。不要填推测值。应用事件源修改和通知方向已获准，不再列作重复授权项。

- 本批目标环境。真实应用启动需要外部 Nacos、MySQL 和 Redis。是否允许启动，未批准。源码修改和离线编译测试不等于真实启动授权。
- B01 的目标接口最终选择和测试账号。
- S06 的受控失败方式。
- 各环境的容器名、nodeId 和 `PI_OPS_*` 注入位置。
- 场景 T、W、R、采样间隔、调用超时。
- 实际 run 数、最大模型调用数、最大外部消息数和允许重跑次数。

模型调查、企业微信消息和真实群可见性都是 `NOT_RUN`。`DELIVERED` 只表示 `FakeNotifier` 或内部任务状态，不证明群身份或群内可见。

## 停止边界

出现下面任一情况就停止，保留已有记录，不要扩大场景，不要重评分旧失败。

- 需要 SSH、远端 HTTP、部署、Docker 操作、故障负载、真实模型调用或外部通知。
- 需要读取或打印 token、webhook、完整 Env 或模型凭证。
- 需要修改 Accepted ADR、PINNED Proof、Evidence floor、guards、生产策略或协议才能让检查通过。
- 真实发送器没有发出预期信号，却想用手工事件补成接入 `PASS`。
- 聚合窗或健康样本数在失败后被调低，并想沿用原评分。
- 共享依赖或宿主机成为故障手段。
- 基础设施命令失败。失败就是失败，不改记为 `PASS`。
