# 本地 Java17 / Docker 真实故障演练事实报告

日期：2026-10-03（run ID/时间为 UTC）。分支 `test/local-fault-drills`，基线 `d3fdb1ab402a04a063cbe963723ee90bbbde3743`；未 stage/commit、未部署远端、未修改治理门槛。

**更正：此前39个DELIVERED任务用户确认误投生产群。** 原记录保留，只能证明旧渠道的平台接受，**不得作为测试渠道通知验收**。本地演练标签、串行限速和DELIVERED状态均不能证明目标是测试群；此前执行者没有核对机器人目标身份，这是配置核对失误。未撤回或修改任何生产消息，现接口也不提供此能力。新测试机器人由主会话写入gitignored配置，仅比目标digest，不公开旧/新URL。

**结论：尚不可转测。** 旧完整矩阵与核心第二轮有真实执行结果；17份报告独立只读审查已完成，限定范围评分9 PASS / 6 GAP / 2 FAIL，不等于全目标通过。W2首轮命名归因错误、N3无引用失败及其他GAP保留。审查唯一要求修正的旧smoke身份兼容回归本次已修、配置回归已执行；旧smoke没有重跑。测试渠道纠正阶段仅另行单次B4验证；2026-10-04再按新授权执行Java六轮，不能追认旧39任务为测试验收。

## 证据与交接绑定

仓库绝对路径前缀：`/Users/hejiayuan/code_me/pi-ops/`。

- 首次默认阈值失败：`deploy/local/data/fault-drills/20261003-065926/`。
- 第一轮与失败的 F1 参数：`deploy/local/data/fault-drills/20261003-070316/`。
- F1 成功及核心第二轮：`deploy/local/data/fault-drills/20261003-072902/`。
- 综合原文/ID/引用结构索引：最后一目录的 `fact-index.json`，覆盖 **24 个独立 run、20 个 Incident、17 个 COMPLETED 报告、39 个通知 job**。
- 各 run 原始证据：`deploy/local/data/jdk17/<下表 run-id>/`；独立 `ground-truth.json` **未挂载或发送给 Runtime**。`artifacts/` 保存 Docker raw events、State/限额、应用/JFR/Node/中央/runtime logs、二进制 JFR 及打印、operator raw/safe/detail JSON、live 与 after-stop SQLite/全表 JSON。
- 检查日志：`deploy/local/data/fault-drills/validation/`；Java 组件本轮证据：`deploy/local/jdk17-drill/.checks/20261003T065850350865Z/`。
- 外部交接：`/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/95572050-2f9f-430d-bd6b-7c595d1c9c7d/reports/integration-drills.md`。

旧证据 `deploy/local/data/jdk17/20261002-093410/` 未清除或覆盖；没有用旧证据补本轮空缺。

## 实现、真实环境与边界

复用现有 Compose/smoke topology。新增 opt-in `docker-compose.fault-drills.yml`、stdlib `fault-drills.py` 和两个纯配置回归；不是通用测试平台。既有 smoke 不变。

Java 组件来自 managed-worktree `pi-worktree-2864c7a9-70c4-4215-bd37-fb5b2d0b1182-s0-0` / branch `pi-subagents/java-demo-2864c7a-c9cd-s0-t0`，相同基线。handoff/patch 位于 `/var/folders/vx/rvncwjc574jfghb_hm7pm89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/2864c7a9-70c4-4215-bd37-fb5b2d0b1182/`。遵照源修改只能 edit/write 的协调决定，**未执行修改工作树的 git apply**；用 write/edit 重放，`Drill.java`、`check.py` 与组件最终文件 cmp 一致，Dockerfile 同组件；README 压缩并补集成指引。patch 保留为来源证据。

旧完整矩阵阶段的唯一产品修复：Docker watcher 在 state tracking/转换前，以实际 `Actor.Attributes.name` **精确匹配**现有 `allowedContainers`；非目标、缺名字、前缀相似名字被忽略，空名单发现零容器，不放开全部。HTTP/host 探测独立。新增运行的 watcher 回归覆盖目标/非目标/空名单；真实矩阵中的 Docker 事件仅形成当前 demo 的 Incident。没有新增远程执行、CPU/log 插件、SDK 修复或协议字段。

实际环境：

- Docker Engine 29.4.0，OrbStack Linux/aarch64，kernel `7.0.11-orbstack-00360-gc9bc4d96ac70`，cgroup v2，VM 10 CPU；host Evidence 是该 VM/Node 环境，不是物理 Mac 的独占资源指标。
- 宿主真实 JDK：`/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`，Temurin 17.0.18+8；容器 Temurin 17.0.20.1+1。镜像 ID 和每次限额在 Docker artifacts 中。
- demo CPU=2，CPU 工作 2 线程/8 秒（N2 为 1 线程）；heap 默认 Xmx128MiB、容器 memory/swap 各512MiB；B2 Xmx256MiB、memory/swap 各192MiB；restart=no。端口 loopback。
- 实际 REAL `cpa/gpt-5.6-sol`。默认 execution budget **30000ms** 先实测；之后显式 **300000ms**。本地调查重试上限显式1以限通知/调用，不能称为“所有产品默认配置通过”。
- host memory/disk poll10s、默认连续3样本；HTTP interval2s、连续2样本；N1 观察45s完整窗口。sender=true（白盒/负例）或显式false（黑盒），未手工提交 EventBatch。
- 秘密仅由 gitignored `.env`、`.env.jdk17`、`.env.jdk17-models.json` 交给 Compose；未打印展开 Compose/Env，未提交凭据。脚本排除 ambient PI_OPS 变量；本次运行环境原本也没有这些变量。

应用/HTTP service=`order-service-本地演练-<中性runid>`；Docker container=`order-local-drill-<中性runid>`，allowlist、事件 containerName、health mapping 精确一致。Docker 名只能 ASCII，因此通知用英文 local-drill+runid。标注演练来源但不透具体根因；真实栈保留 `Drill.java`，因此不是完全不知道 demo 来源的盲测。

## 第一轮：逐阶段事实

此表为原演练执行记录；原“待审”标签是当时状态，现以以下独立审查17项评分为准，COMPLETED不代表准确诊断。**本节及核心第二轮的所有通知均发往用户确认的生产旧渠道，不算测试渠道PASS。** `NOT_RUN` 是无触发/无session时未调用下游，不是成功。

| 场景 | run-id | 发现 | 收证 | 诊断/执行（旧记录） | 旧生产渠道通知 | 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| W1 默认 demo 阈值0.80 | 20261003-065926-1e4855 | FAIL：实际忙循环最高约0.197，未越阈值 | NOT_RUN | NOT_RUN | NOT_RUN | CPU自动结束；已安全停止等待 |
| W1 默认30s，显式阈值0.10 | 20261003-070317-154e8f | PASS | PASS：JFR/stats/load | FAIL：30.019s execution timeout | OPEN一次DELIVERED，无completed | CPU结束；Incident无恢复映射 GAP |
| W1 显式300s | 20261003-070433-0f7900 | PASS | PASS：JFR/stats/load，动态stats | 执行完成78.981s/待审 | 2 DELIVERED | 工作停止；Incident GAP |
| W2 heap OOM | 20261003-070638-08f166 | PASS：真实OOME/custom JFR | GAP：成功envelope，但异常属性/日志未进入完整JFR语义 | 执行完成35.305s/待审 | 2 DELIVERED | health200，OOMKilled=false；Incident GAP |
| W3 请求业务异常 | 20261003-070758-8ae99c | PASS：真实异常/custom JFR | PASS：JFR envelope、inspect、实际异常logs | 执行完成39.860s/待审 | 2 DELIVERED | health200；Incident GAP |
| B1 sender-off CPU | 20261003-070922-39eef9 | GAP：有真实CPU/JFR日志、无主动CPU Incident | NOT_RUN | NOT_RUN | NOT_RUN | health200，工作结束；未用health故障补偿 |
| B2 cgroup OOM | 20261003-071020-159e41 | PASS：raw oom+die，两个类型Incident | PASS：inspect/logs/stats/host.memory | 两报告完成23.570/30.075s，待审 | 4 DELIVERED | kill不可原地恢复；NOT_RUN |
| B3 非零退出 | 20261003-071135-9be1bf | PASS：die，ExitCode17、OOMKilled=false | PASS：inspect/logs | 执行完成18.770s/待审 | 2 DELIVERED | 未重启已退出工作负载；NOT_RUN |
| B4 503→200 | 20261003-071238-68ee23 | PASS：一Incident | PASS：http.probe成功取到503不健康事实、inspect/logs | 执行完成36.524s/待审 | OPEN/COMPLETED/RECOVERED各一次DELIVERED | PASS：同Incident RECOVERED |
| B5 仅业务日志 | 20261003-071410-041a3c | GAP：真实异常日志、health200，无日志主动发现 | NOT_RUN | NOT_RUN | NOT_RUN | health200；未加健康失败 |
| N1 旧overlay阈值0.01 | 20261003-071508-287dcc | PASS：完整观察窗口零新Incident | NOT_RUN（无故障触发） | NOT_RUN | 零通知 | health200 |
| N1 显式阈值0.10 | 20261003-071636-92fc4b | PASS：完整观察窗口零新Incident | NOT_RUN | NOT_RUN | 零通知 | health200 |
| N2 低于阈值1.0 | 20261003-071805-8c7325 | PASS：实际采样、sender和检测启用，无压力Event/Incident | NOT_RUN | NOT_RUN | 零通知 | health200 |
| N3 正常exit0/start | 20261003-071903-398486 | GAP：exit0本身忽略，但start被记为restart故障 | GAP：无计划证据 | 12.093s完成但无Evidence引用，FAIL引用要求；内容待独立审查 | 2 DELIVERED（维护误报） | 正常工作负载恢复，不等于Incident恢复 |
| F1 默认poll1s | 20261003-072005-d07e68 | PASS：真实CPU触发 | 失败为retryable，但job3次耗尽；恢复Node不重入队 GAP | NOT_RUN：没有session，不是模型失败 | OPEN一次DELIVERED | FAIL：同job未恢复取证 |
| F1 poll10s | 20261003-072207-bd51b1 | PASS | 同样在恢复前耗尽3次 GAP；等待被安全中断 | NOT_RUN | OPEN一次DELIVERED | FAIL；原失败快照保留 |
| F1 显式poll60s/max3 | 20261003-072902-99ca10 | PASS | PASS：失败快照PENDING/attempt1、retryable/data=null；恢复后同job/generation1/同Evidence成功，attempt2 | 执行完成75.271s/待审 | 2 DELIVERED | PASS：Node恢复后可取证；CPU Incident仍无恢复映射 |

低阈值/启动样本与监测窗口日志全部保留；N1不宣称发送器启动时永不失败。0.80未越阈值不能拿来证明模型30s失败，因此另起了0.10、30s的实际事件。10 CPU VM 的 CPULoad 归一化与2 CPU容器限额不是同一分母，不能把JFR约0.197直接说成容器只用了19.7%限额。

B2 两轮均有 **Docker raw oom + OOMKilled=true + ExitCode137 + Memory=MemorySwap=201326592 + NanoCpus=2000000000**，不是仅用137推测OOM；oom/die分别形成两个Incident属现有类型/fingerprint策略。B3 两轮为真实Java退出17且OOMKilled=false。W2两轮真实Java heap space OOME后释放引用、GC、继续health200，与容器OOM分开。

## 核心第二轮

全部独立DB和中性runid；均实际执行，不引用上轮证据。

| 场景 | 第二轮run-id | 发现/收证 | Runtime耗时(s)（旧记录） | 旧生产渠道通知/恢复 |
| --- | --- | --- | --- | --- |
| W1 | 20261003-073157-b4d700 | PASS/PASS | COMPLETED 85.740 | 2 DELIVERED；Incident恢复GAP |
| W2 | 20261003-073410-464067 | PASS/语义GAP | COMPLETED 24.763，待审 | 2 DELIVERED；health200、非Docker OOM |
| W3 | 20261003-073519-3b5482 | PASS/PASS | COMPLETED 34.696 | 2 DELIVERED；health200 |
| B2 | 20261003-073639-b649e0 | PASS/PASS：真实oom+die两Incident | COMPLETED 37.677/39.133 | 4 DELIVERED；保留被kill状态 |
| B3 | 20261003-073803-b9b02e | PASS/PASS：退出17、非OOM | COMPLETED 29.106 | 2 DELIVERED |
| B4 | 20261003-073917-7fde99 | PASS/PASS：仍一Incident/一session | COMPLETED 31.450 | 3 DELIVERED，RECOVERED |
| F1 poll60s | 20261003-074043-4f0861 | PASS：同job attempt1失败→attempt2成功，generation1 | COMPLETED 102.433 | 2 DELIVERED，Node取证恢复PASS |

## 旧轮原文、引用与诊断问题

`fact-index.json` 保存每份报告的原始 hypothesis/recommendation、Session/Incident/Evidence ID 与 runtime metadata/task原文。`after-stop-pi-ops-tables.json` 中 `investigation_context_snapshots.context_json` 是冻结的模型视图；`after-stop-pi-runtime-tables.json` 保存原始context/result/metadata；动态查询 audits/evidence 也在中央全表中。provider原始assistant token transcript未被现有adapter保存，不能宣称已取得完整供应商response。

结构检查：所有**已有引用**ID存在、属于报告当前Incident且Evidence succeeded，没有跨Incident借证；N3报告零引用，不能满足本Goal。结构正确仍不证明内容支持主张。

独立只读审查确认的旧轮缺口如下；保存旧结论，不用后续代码修复重评分这些报告：

1. W2首报告把JFR事件名写成因果/修复路径：`The incident was directly caused by Java heap exhaustion in com.example.MemoryFailure.`；建议含 `remediate the allocation/retention path in com.example.MemoryFailure`。它是观测事件名，不是已证实的分配热点。只保留事实/原文，未擅自修改SDK或提示词来重评分。
2. 非CPU jfr.signal投影清空异常附加属性；W2没有heap专用日志/inspect计划，自定义异常语义未闭环，记GAP，不把envelope接收成功称完整支持。
3. W1动态docker.logs/inspect被trusted planner拒绝，缺少quota/throttling/线程栈等事实；报告需保留不确定性，不能说已观察这些内容。
4. N3现策略把正常exit0/start当“restarted after failure”，空Evidence的模型COMPLETED不可当准确诊断。未扩展维护平台或顺手改策略。
5. F1默认预算耗尽后没有自动重入队/操作员证据retry API；60s演练参数成功不能冒称默认恢复通过。失败Evidence终态upsert会被成功覆盖，必须同时查看 `node-unavailable-*` 原快照。

旧轮39通知job均DELIVERED、attempts=1；**用户确认这是生产群误投，不是测试渠道验收**，包括N3误报和超时/取证失败的OPEN。实现仅在HTTP成功且WeCom errcode=0时置DELIVERED，但原始响应body未持久化，receipt GAP；DELIVERED不能证明人已看到。原记录、原报告和失败快照不撤回、不覆盖，也不向旧机器人发送验证/解释消息。

## 独立审查：17份旧报告逐项事实评分

来源：`/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/95572050-2f9f-430d-bd6b-7c595d1c9c7d/reports/independent-review.md`。只读审查交叉核对JSON/日志/JFR打印，未直接查SQLite、解析二进制或重算SHA；原文和引用仍在fact-index及after-stop表中。9个PASS均是下列限定分类/不确定性成立，不是完整产品或测试渠道验收。

| 报告（run-id/type，唯一定位fact-index内report） | 评分 | 事实边界 |
| --- | --- | --- |
| 20261003-070433-0f7900 / jvm.cpu_pressure | GAP | 短时JVM user CPU和低host load成立；“moderate container activity”不能证明未逼近2CPU限额，quota/throttling未知 |
| 20261003-073157-b4d700 / jvm.cpu_pressure | GAP | 同上；“not sustained ... container CPU saturation”不足以排除8秒峰值，未取得inspect/logs/线程栈 |
| 20261003-070638-08f166 / jvm.oom | FAIL | “heap exhaustion in com.example.MemoryFailure”及修该allocation path把观测事件名当分配路径；真实栈是Drill.exhaustHeap，引用attributes={}不支持该路径 |
| 20261003-073410-464067 / jvm.oom | PASS（限定） | heap OOME分类、深因未知成立，未误称Docker OOMKilled；异常投影仍GAP |
| 20261003-070758-8ae99c / business.error | PASS（限定） | 应用异常分类、真实库存原因不确定成立，JFR/真实logs/inspect支持 |
| 20261003-073519-3b5482 / business.error | GAP | 应用报出inventory unavailable成立，但Drill无条件throw且无库存查询，不能证明现实库存短缺 |
| 20261003-071020-159e41 / container.oom | PASS（限定） | 实际inspect OOMKilled=true/137/192MiB与host.memory支持容器OOM；具体分配区未知 |
| 20261003-071020-159e41 / container.die | PASS（限定） | 同次raw oom+inspect支持OOM，未定位具体堆/本地内存占用 |
| 20261003-073639-b649e0 / container.oom | PASS（限定） | 第二轮实际OOM事实支持；不依赖归一化Event中的错误oomKilled=false |
| 20261003-073639-b649e0 / container.die | PASS（限定） | 同上；oom/die两个类型Incident，不宣传为单Incident去重 |
| 20261003-071135-9be1bf / container.die | GAP | exit17与深因未知成立，但“OOM and CPU exhaustion are contradicted”过宽，OOMKilled=false不能排除Java heap OOME，低采样不能排除所有时刻CPU |
| 20261003-073803-b9b02e / container.die | PASS（限定） | programmatic exit17成立，OOM kill“not supported”，退出码含义仍未知 |
| 20261003-071238-68ee23 / health.failure | PASS（限定） | 进程仍运行、probe503、具体失败检查未知；数据库/cache只是建议，无实际依赖故障证据 |
| 20261003-073917-7fde99 / health.failure | PASS（限定） | 同上；恢复和三类旧渠道通知各一次，不能追认测试通知验收 |
| 20261003-071903-398486 / container.restart | FAIL | 引用为空；正确保留原因未知，但正常exit0/start是策略误报，不满足有证据诊断 |
| 20261003-072902-99ca10 / jvm.cpu_pressure（F1） | GAP | 短时CPU和恢复后的低负载成立；后取stats不能重建故障峰值/quota，不是Node根因诊断 |
| 20261003-074043-4f0861 / jvm.cpu_pressure（F1） | GAP | 同上；Node取证恢复PASS不等于CPU Incident恢复 |

16份非空引用均存在、属当前Incident且succeeded；N3没有引用。W2首轮错误未被第二轮PASS吞掉。B2 Event归一化oomKilled=false与后续inspect=true不一致，必须使用raw oom/真实inspect判定。2026-10-03纠正仅修兼容回归与本地防误投控制；本轮另有明确授权的Java局部修复，其他能力/策略GAP仍不扩大。

## 测试渠道纠正：唯一实际B4（2026-10-03 UTC）

本次范围仅旧overlay身份兼容、本地目标校验及一次健康503→恢复；未重跑旧smoke、完整矩阵，未ping机器人、回放旧队列或发送生产解释消息。8项纯配置回归已真实运行PASS（兼容身份/fault覆盖、去shell PI_OPS变量、错误digest/kind/预算阻止启动、实际停止容器Env验证、精确ID启动顺序、异常B4任务停止）；不调用模型/通知，不冒称旧smoke PASS。

防再次误投措施：

1. Runner去除shell所有PI_OPS覆盖。Compose依次使用compose.env和gitignored .env.jdk17，environment优先于env_file；不是仅相信文件名。离线渲染在内存中计算**完整URL SHA256**，只保存digest/匹配状态，不保存完整config/Env。
2. 固定测试digest=`6598344a5e775ded5efaf0455f05854f473409c159ec58dfcbb8fd40ee7876e1`，不能经shell/CLI替换。每次必须kind=wecom、maxAttempts1、batchSize1、独立新DB挂载。
3. 中央只create不start（当前CLI支持`up --no-start --no-deps --force-recreate`），再次比实际容器Env的digest和停止/新DB状态，再`docker start`该精确ID。任一不符就不start；B4出现非目标Incident、额外/重复/异常通知类型立即停观察器与发送服务。
4. Observer先停再替换demo，精确容器名单和1s replay窗口，fresh run/DB不接旧通知任务。此次发送服务、观察器和负载结束后全停。

首次预检run `20261003-114008-b9fab0` 因`docker compose create`不支持`--no-deps` BLOCKED，在任何/fail及中央start之前失败。actions=[]、新中央DB不存在、runtime任务0；cleanup全停，旧容器cleanup日志不作为本轮发送证据。记录在`deploy/local/data/fault-drills/20261003-114007/`和对应jdk17 run目录，保留未覆盖。经主会话明确批准后，核对CLI支持的no-start参数，仅新起下面一个实际故障run；不是重试发送。

唯一实际B4 run：**20261003-114406-bc1c66**。

- 绝对证据：`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/jdk17/20261003-114406-bc1c66/`；group=`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/fault-drills/20261003-114405/`。检查/CLI失败及授权单次日志：`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/test-channel-correction/`。
- 两份发送前证明：`artifacts/notification-target-rendered.json`（11:44:06.264Z）、`notification-target-container.json`（11:44:12.109Z），两者完整URL digest均等于固定测试值，kind=wecom、maxAttempts=1、batch=1、fresh DB=true，后者senderStopped=true。没有发布任何URL、完整inspect/Env/config。
- ground truth仅一次/fail（11:44:18.284Z）、一次/ok（11:44:53.677Z），均开发控制HTTP200；实际健康探测取到503→200。sender=false、demo2CPU、memory/swap各512MiB/Xmx128MiB、restart=no，中性演练标签+新runid。
- Incident `inc-10bdfe37-6ea5-4108-af54-21d56248a72d`，唯一health.failure，同ID最终RECOVERED/eventCount2；continued-failure阶段OPEN/eventCount1，没有持续503重复建单。
- Session `isess-78bfb637-a1c5-44b6-bf58-0d58424ee7c0`，唯一COMPLETED。REAL cpa/gpt-5.6-sol、显式300s，任务耗时30.967s；不是默认30s通过。原context/result/metadata/report在after-stop表和operator原视图。
- 四条Evidence成功：deterministic http.probe（503不健康事实）、docker.inspect、docker.logs，以及dynamic docker.logs。原报告引用三个当前Incident的成功Evidence，结构核对PASS；内容独立审查已完成、诊断GAP。只读复核接受有界纠正交付，但原文“container and JVM are healthy ... internal readiness/health condition or required dependency is unavailable”超过证据：只能支持进程运行、HTTP503及具体健康条件未知，不能确认JVM全面健康或依赖故障；另保留docker.stats请求被拒。来源：`/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/6597bc00-83a0-4c7c-ac48-5fda209ce020/reports/test-channel-recheck.md`。未修改这份旧模型原文或补跑B4。

| 本次测试目标通知job | 状态 | attempts / lastError | deliveredAt (UTC) |
| --- | --- | --- | --- |
| njob-open-inc-10bdfe37-6ea5-4108-af54-21d56248a72d / INCIDENT_OPEN | DELIVERED | 1 / null | 11:44:22.269Z |
| njob-completed-isess-78bfb637-a1c5-44b6-bf58-0d58424ee7c0 / INVESTIGATION_COMPLETED | DELIVERED | 1 / null | 11:44:53.261Z |
| njob-recovered-inc-10bdfe37-6ea5-4108-af54-21d56248a72d / INCIDENT_RECOVERED | DELIVERED | 1 / null | 11:44:58.345Z |

发现/收证/恢复PASS，通知目标校验PASS，三类平台接受**仅间接证据PASS**；**原始发送响应receipt GAP、人类群内可见性NOT_VERIFIED**。有限现成发送证据在`artifacts/notification-evidence.json`及after-stop通知表（id/type/status/attempts/lastError/deliveredAt），不把推导的errcode0伪装成捕获的原始response。按批准方向未增加preload/fetch拦截或额外转发层。原39生产渠道记录与本次3测试目标记录严格分开。

本次纠正实际重跑`pnpm typecheck`、`pnpm build`、`pnpm test`均退出0（507 PASS/1 skip/0 fail）；8项配置回归PASS，显式全13项改动plan READY/advisory，gaps仍INV-EVD-02:A missing=1。日志位于test-channel-correction目录；未重跑旧smoke、Java组件全场景或trusted fullGate。

cleanup恢复健康后，observer、demo、中央与runtime均Running=false，见`artifacts/cleanup-docker-states.json`；新旧DB/logs/JFR/事件保留。未stage/commit/push/部署，未更改远端生产消息。当前兼容回归仅配置修正/8 tests与离线实际Compose渲染通过，旧smoke真实执行NOT_RUN；治理INV-EVD-02:A缺口与trusted fullGate NOT_RUN仍未消失。

纠正交接绑定：`/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/6597bc00-83a0-4c7c-ac48-5fda209ce020/reports/test-channel-correction.md`。

## SQLite一致性、清理与验证

live host-volume SQLite导出与operator API出现可见时差，故原live快照不删除，同时在对应writer关闭后再次只读导出/一致backup，命名 `after-stop-*`，终态统计以此与原operator JSON交叉核对。没有修改业务DB或补写Event/Evidence。F1恢复前失败快照独立保留。

结束时 observer、所有本轮demo、最后中央/runtime writer均已停止；存活应用先恢复 `/ok`，CPU有界结束、heap释放；被kill/退出容器保留原State，不能伪称仍健康。无关 `pi-ops-drill` 和 notification-sink 未注入故障、未清除。cmux只操作workspace:2的辅助pane:14/surface:36，主pane:2/surface:3从未关闭，操作后focus-pane回主pane。

| 验证 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS：507 passed、1 skipped、0 failed；这是unit，不代替真实drill |
| `pnpm lint` | 退出0，但各包lint未配置，不能当有效lint验收 |
| 真实JDK17 `check.py` | PASS：on/off真实CPU/custom JFR/heap OOME、health、exit、负阈值 |
| `PYTHONDONTWRITEBYTECODE=1 python3 deploy/local/fault-drills.test.py` | 旧记录2 tests PASS；本次纠正8 tests PASS，未调用Docker/模型/通知 |
| `pnpm test:governance` | PASS（不是Trust Anchor/final） |
| 显式所有改动文件 `plan --strict` | READY，architecture PASS；advisory，不是可信fullGate |
| `cli.mjs gaps` | 命令退出0，仍 **1项** `evidence.collection / INV-EVD-02:A missing=1`；未重标Proof/floor |
| `git diff --check` / staged检查 | PASS / staged为空 |
| trusted fullGate、旧17报告独立诊断审查 | NOT_RUN / 审查完成（9限定PASS、6GAP、2FAIL）；不允许据此宣称可合并 |

## 重跑与下一步

先确认共享端口和目标项目；需要真实已配置模型/企业微信，不能与旧smoke并行。下面仅保留历史矩阵复现命令，会发送真实通知且不清理数据，不是再次联网的授权。旧`W1-default`命名指原30s预算复现，不代表修改后的产品默认。当前Java默认验证命令见文末，任何再次发送须owner新授权。

```sh
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
  python3 deploy/local/jdk17-drill/check.py
PYTHONDONTWRITEBYTECODE=1 python3 deploy/local/fault-drills.test.py
python3 deploy/local/fault-drills.py --execute --build --repeat-core
# 有界子集；30s先测、300s另列，F1显式poll60s/max3：
python3 deploy/local/fault-drills.py --execute --cases W1-default,W1,B4,F1
```

本次实际分三批运行：初始 `--execute --build --repeat-core` 在默认阈值不越限后安全中断；第一轮 `--cases W1-default,W1,W2,W3,B1,B2,B3,B4,B5,N1-legacy,N1,N2,N3,F1-default,F1 --repeat-core` 在poll10s预算耗尽后安全中断；最后 `--cases F1,W1,W2,W3,B2,B3,B4,F1` 完成。三个原始matrix log均保留，未把中断退出码当PASS。

旧17报告独立评分已纳入；本次纠正只执行一次测试渠道B4，不重跑上述历史全矩阵，不补发ping或旧队列。B4只读复核已完成，诊断GAP保留；旧轮事实不因后续Java修复而重评分。主动CPU/log探测与正常维护策略未扩展；后续Java局部修复及新证据见下节。真实DataAsset、两台测试机器、跨架构、长期稳定性及远端部署仍 **NOT_RUN**。

## Java链路局部修复（2026-10-04 UTC）

### 为什么Docker黑盒CPU/业务日志不能主动发现

发现与收证是两条不同路径。Node Agent装配Docker生命周期watcher、host memory/disk及显式HTTP health detector，没有CPU阈值采样告警，也没有日志tail/error detector。`docker.stats`、`host.load`、`docker.logs`是Incident出现后或活跃调查中的有界只读查询，不会因“查询能力存在”自动产生Event。Docker lifecycle stream也不会为一次普通CPU忙循环或业务错误日志产生对应故障事件。

因此B1关闭sender且health200时，真实CPU/JFR只在应用本地记录；B5关闭sender且health200时，真实异常只在日志/JFR，不进入中央发现入口。没有Incident就没有自动收证/模型/通知触发。这是缺少主动CPU/log detector的能力GAP，不是Docker无法读CPU/日志，也不是模型漏看已收到告警。本轮不新增这些detector、不改N3维护策略或F1重入队平台；旧失败证据保留。

### 本轮直接根因与最小修正

- `jfr-evidence.ts`原非CPU属性清空。现在仅为`jvm.oom`和`business.error`保留有界、明确allowlist：`exceptionClass/exceptionMessage/stackTrace/jfrStackTrace`、原JFR名/时间、containerName、业务operation。字段按实际Drill consumer拼写（wire是`stackTrace`，不是另造`exceptionStack`）。class256、message1024、两个stack各4096字符，时间须可解析/最多64字符，其余一般字段256。未知type仍空attributes；metadata单独不升primary。OOME必须有正确异常类及非空异常文本/栈；business须合法限定类及文本/栈。projector与分类器共享recognizedJfrSemantic，异常eventType/semanticType一致；模型safe视图仍走既有脱敏/字节上限。ADR-0028及新增C级catalog项说明此异常边界，不冒称旧CPU-only回归已证明异常。
- 初始`jvm.oom`补mapped inspect、事件窗logs与host.memory；CPU补inspect以取得实际配额。Runtime原只能补初始计划中的类型，导致CPU inspect/logs、health stats被拒。共享可信Docker resolver现在允许既有readonly inspect/stats/logs，target只取存储触发Event的containerName，或已支持Docker oom/die的可信service fallback；缺映射拒绝，Node仍exact allowlist。logs复用事件前后2分钟/maxLines helper；HTTP仍仅可信health detector URL，模型不能自选容器/URL。
- Node只留累计CPU计数不足。现在保留Docker真实read/preread、cpu_stats/precpu_stats中total_usage、system_cpu_usage、online_cpus，以及inspect Memory/MemorySwap/NanoCpus/CpuQuota/CpuPeriod/CpusetCpus；不暴露Env、不生成cpuPercent/峰值。累计counter不是百分比，只有实际区间才能解释该区间，事后低snapshot不能排除先前压力。
- 沿原REAL specialist/coordinator路径保留主会话中文修改，加入共同证据边界，synthesis可见实际safe Evidence而不只转述findings。JFR事件名是观测名、异常文本不能证明现实库存/依赖原因，OOMKilled=false不能排除Java heap OOME，容器运行不能保证JVM健康。模型原文不改写，findings结构化摘要写runtime日志便于复核，不保存链式思考。当前报告引用/内容仍须fresh只读审查。

### 有界默认预算与预检事实

历史真实30.019s超时保留。最短修法不能让顺序多specialist/补证/synthesis在已测78–102s内通过30s，因此产品whole-investigation默认仅从30s调到300s，仍可配置1..600000ms，withDeadline中止/失败及短deadline回归保留；`.env.example`同步，未改变DataAsset阈值策略。中央stale默认900000ms覆盖300s调查；中央submit client实际8000ms只是异步ack时限，不是调查总时限，callback5000ms及补证单次时限不扩大。没有额外调查lease或无限等待机制。

首次run `20261004-051825-4cd757`在预算预检即BLOCKED：environment:null从项目配置重新解析旧30000，actions=[]、新中央DB不存在、0新通知；原目录保留。授权继续前离线也核实`!reset null`仍回填旧值，没有据标签假定删除成功。最终本地默认验证overlay仅替换Runtime env_file/environment两处来源：原秘密`.env`原位引用不复制，公开compose.env的token仍用模板传入，移除budget键，不改秘密文件。离线最终渲染确认key确实不存在，Runtime先no-start创建、再内存校验实际Env不存在key且未启动，start精确ID，随后health暴露effective executionTimeoutMs=300000。不是仅把overlay硬编码300s称默认通过。

CPU本地校准仍明确0.10，2线程/8秒、容器2CPU/512MiB；0.80未越阈值的旧失败保留。JFR机器归一化ratio和容器配额分母不同，0.10不是任意部署通用CPU策略。自定义MemoryFailure的原始JFR时间是释放内存后实际commit时间，不冒称VM抛出瞬间；builtin JavaErrorThrow未据本轮宣称已验证。此后新证据不用于重评分旧9限定PASS/6GAP/2FAIL或追认39生产误投。

### 六个独立run的逐阶段记录

新证据group绝对路径：`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/fault-drills/20261004-052618/`。每个run完整证据绝对路径为`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/jdk17/<run-id>/`。此处PASS只指对应可复核阶段；模型内容不由执行者自评分。

| 场景/轮次 | run-id | 发现 / 收证 | REAL执行（秒）/诊断 | 测试目标通知 | 工作负载 / Incident恢复 |
| --- | --- | --- | --- | --- | --- |
| W1 / 1 | 20261004-052619-faa771 | PASS / PASS，JFR+quota inspect+有效CPU区间+logs/load | COMPLETED 147.866 / 限定PASS | OPEN+COMPLETED各DELIVERED一次，attempt1 | health200、CPU结束 / GAP无恢复映射 |
| W2 / 1 | 20261004-053012-36c038 | PASS / PASS，实际heap OOME/customJFR异常属性、inspect/logs/memory | COMPLETED 147.247 / 限定PASS | 同上 | 释放内存、health200、OOMKilled=false / GAP |
| W3 / 1 | 20261004-053325-ca8d4b | PASS / PASS，真实500/异常/customJFR、inspect/logs | COMPLETED 75.859 / GAP，业务归因与探测建议超出证据 | 同上 | health200 / GAP |
| W1 / 2 | 20261004-053526-be8ec9 | PASS / PASS，独立JFR/真实区间与quota | COMPLETED 136.864 / 限定PASS | 同上 | health200、CPU结束 / GAP |
| W2 / 2 | 20261004-053830-f98926 | PASS / PASS，独立OOME及模型可见异常字段 | COMPLETED 171.451 / 限定PASS，补证专员失败保留 | 同上 | health200、OOMKilled=false / GAP |
| W3 / 2 | 20261004-054208-d11280 | PASS / PASS，独立异常与模型可见operation/栈 | COMPLETED 75.612 / GAP，补证专员失败保留 | 同上 | health200 / GAP |

- 总计6个真实JFR Event、6 Incident、6 COMPLETED session、12新通知job，全部attempt1/lastError=null。没有黑盒/健康故障重跑、ping、历史队列回放或生产解释消息。六次双digest均等于确认的测试完整URL SHA256 `6598344a5e775ded5efaf0455f05854f473409c159ec58dfcbb8fd40ee7876e1`；sender停止/新DB证明保留。仍只有DELIVERED+现实现的间接平台接受，原始receipt GAP、人类可见NOT_VERIFIED。
- 六次渲染、停止Runtime Env、启动后effective health均证明预算来自无env覆盖的产品默认300000；实际75.612–171.451s成功。其他本地配置仍显式：64KiB Runtime context、0.10 demo校准、1次调查/通知预算等，不称所有产品默认均通过。公开compose.env仍保留历史30s显式值，旧smoke没有重跑。
- `java-fact-index.json`保存所有Event/Incident/Evidence IDs、raw rows、冻结context、完整报告/metadata/findings/补证审计/通知job。每run的`projection-reference-check.json`核对原始Event字段=raw jfr.signal=冻结模型字段（CPU或异常原名/时间/栈/operation），每个非空引用均当前Incident+succeeded；这不是内容评分。二进制JFR及真实JDK17打印、raw/safe operator视图、Docker事件/状态/限额、SQLite备份/全表和独立truth均保留。没有改写原文或覆写评分。
- `model-reports-original.md`为六份保存的原文，`chinese-notification-previews.md`为既有formatter的离线纯展示预览，无HTTP调用、额外模型翻译或虚构receipt。12个preview分别283–2257 UTF8 bytes，均≤4000；原始hypothesis及建议为中文，technical identifiers/Evidence IDs保留。旧policy前缀仅展示隐藏，持久化原文不改。
- W1原文说明机器10CPU分母与NanoCpus=2核，并按真实read/preread区间解释约1.9–2核，再明确事后低负载不能排除故障期压力；完整峰值、持续性/throttling/热点未知。W2不再把MemoryFailure当分配路径，引用真实OOM类与Drill.exhaustHeap栈、保留-Xmx/GC等未知。W3仅能确认应用异常，现实库存/外部依赖仍未知；首轮建议用http.probe等价请求可能超出仅GET/HEAD可信health probe能力，业务“判断分支”仍是假设，须fresh reviewer逐项核对，不升级PASS。

当前测试：targeted回归通过，`pnpm typecheck/build/test`真实退出0，unit515 PASS/1 skip；配置10 tests通过。早期typecheck测试helper返回类型错误、两次旧model-safe fixture没有持久触发Event导致拒绝的失败日志保留，已改可信fixture而未放宽生产guard。governance validate/self-tests通过；本轮完整33项显式文件`plan --strict`实际为NEEDS_EVIDENCE/exit1（architecture PASS、policy/trust skipped/advisory），`gaps`仍INV-EVD-02:A missing=1。不改floor/Proof，trusted fullGate NOT_RUN、不可合并。

cleanup先停observer、/ok实际200，再停demo/中央/runtime，当前四类容器Running=false。前5个demo随后被Compose替换，现已不存在；它们的注入时状态、JFR/日志/停止命令完整保留，不伪造事后ExitCode。无关pi-ops-drill/notification-sink仍原样运行。未stage/commit/push/部署；cmux仅workspace:2辅助terminal，主surface:3未关闭，focus-pane恢复主pane:2。

本轮完整检查/失败预检/manifest与patch目录：`/Users/hejiayuan/code_me/pi-ops/deploy/local/data/java-remediation-validation/`。交接绑定：`/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/8b56892c-b14c-4c66-9f35-e04d06413937/reports/java-remediation.md`。

仅供新授权后的重跑命令（本轮已运行，勿自动再次发送）：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 deploy/local/fault-drills.py \
  --execute --build --java-remediation --cases W1,W2,W3,W1,W2,W3
```

### 六轮独立审查及后续离线修正

独立审查已完成。CPU和堆OOM各两份报告取得限定PASS，两份业务异常报告仍为GAP。审查接受本轮局部修复，不代表全部诊断通过或允许合并。审查记录位于 `/Users/hejiayuan/.pi/agent/sessions/--Users-hejiayuan-code_me-pi-ops--/subagent-artifacts/outputs/8b56892c-b14c-4c66-9f35-e04d06413937/reports/java-remediation-review.md`。

业务异常的实际源码无条件抛出异常。报告推测库存判断分支，证据不足。第一份报告建议用`http.probe`等价复现业务POST，但当前能力仅支持可信健康URL的GET/HEAD。两份报告把可见日志片段称为完整日志，不能据此证明故障窗口完整。第二轮堆OOM报告的“约46秒后”也不准确，原始时间对应约42.57秒。

第二轮堆OOM的`container_host`补证重跑因summary返回object失败。第二轮业务异常的`application_business`补证重跑因hypotheses超过5项失败。系统保留首轮finding后完成综合报告，COMPLETED不代表所有专员成功。这些原始失败及报告均保留。

后续代码仅收紧专员和综合报告共享的证据要求。没有源码或调用证据时，不推测库存分支为较可能原因。报告只能引用可见日志片段。业务POST只能建议人工受控复现，不能声称由`http.probe`执行。专员提示明确summary须为不超过2000字符的字符串，hypotheses最多5项。没有放宽结构校验、增加模型重试或改写旧报告。离线回归只核对这些要求进入两条模型调用路径，不能证明真实模型已遵守要求。未再调用模型、注入故障或发送通知，两份业务报告保持GAP。

receipt及人类可见性、Java Incident恢复、主动CPU/log detector、N3/F1默认策略、治理A缺口、真实DataAsset、两节点、跨架构及长期稳定性仍未关闭。
