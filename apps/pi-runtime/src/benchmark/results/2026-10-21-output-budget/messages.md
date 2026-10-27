# 真实模型值班消息评测

以下消息来自 agent 渲染器的 fake fetch 捕获，没有外发。自动通过不等于能推进恢复。

| 案例 | 模型 | thinking | 输入 token | 输出 token | 耗时 ms | 消息字节 | 自动结果 |
|---|---|---|---:|---:|---:|---:|---|
| dataasset-197 | ark/deepseek-v4.1-flash | off | 8358 | 3363 | 18064 | 3049 | 通过 |
| jvm-heap-oom | ark/deepseek-v4.1-flash | off | 21970 | 10355 | 62612 | 3304 | 未通过 |
| cpu-quota-burst | ark/deepseek-v4.1-flash | off | 17535 | 9800 | 52857 | 3285 | 通过 |
| tag-group-502 | ark/deepseek-v4.1-flash | off | 4616 | 2311 | 12414 | 2627 | 未通过 |
| sop-404 | ark/deepseek-v4.1-flash | off | 4824 | 2473 | 14214 | 2874 | 未通过 |
| health-503 | ark/deepseek-v4.1-flash | off | 3781 | 2060 | 21458 | 2554 | 未通过 |
| stack-overflow | ark/deepseek-v4.1-flash | off | 4699 | 3095 | 33765 | 3393 | 未通过 |

## dataasset-197

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。3049 bytes
- mitigationVisible pass。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### rdl-dataasset-6dfb8e88 诊断完成
**实验或演练端点 LabFaultController.serverFault 被显式调用，主动抛出 IllegalStateException 以完成故障注入验证。
该注入端点被意外暴露给真实流量或被业务路径复用；触发逻辑未知，需读代码与访问日志确认。**
机器：rdl-6dfb8e88
时间：10月14日 11:40（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
异常为 GET /auth/lab/server-fault 在 LabFaultController.serverFault 第25行抛出的 java.lang.IllegalStateException，日志文本为“Real DataAsset lab fault injection”；这只能确认异常类型与抛出位置，触发逻辑未知。
容器处于 running，StartedAt 03:39:59Z，RestartCount=0，OOMKilled=false，内存上限 1.5GiB，NanoCpus=2；仅排除容器 OOM kill，不能排除 JVM 堆 OutOfMemoryError，也不说明 JVM 健康。
docker.logs 为截断投影（原始197行，仅保留第36行与第133-151行），只能引用可见片段，不代表完整故障窗口。

**未知**
调用方身份与来源（演练平台、人工测试或真实流量）未知，需访问日志或网关记录确认。
该端点是否应存在于当前环境、是否需要鉴权与保留，缺少配置与接口契约证据。
故障窗口内 JVM 堆、GC、线程与 CPU 峰值未知；事后低 stats 不能反推故障期无压力。

**下一步**
修复尚未确定。
1. 止损（需批准）：按补证结论处置注入端点或结束演练窗口
前提：已确认调用方与端点归属；如需下线端点已获业务与安全审批
若确认为演练，通知演练方结束并保留证据；若端点不应暴露，通过配置或发布移除或限制该端点。变更前记录回滚方案（保留镜像与配置版本），操作后验证该路径不再产生注入异常。
预期：注入异常不再产生，真实业务不受影响。
风险：误下线可能影响依赖演练的环境；发布需审批并准备回滚。
2. 验证：确认故障窗口内 JVM 与容器无资源性异常
前提：人工具备 docker stats 与 JVM 诊断采样权限
采集当前 docker stats、JVM 堆、GC 与线程快照，与注入时刻对比；若发现堆 OOM 或持续 GC，则另开资源事件处理。全流程只读。
预期：排除或确认 JVM 资源故障，支撑异常仅为注入行为。
风险：诊断采样带来轻微负载；不得据此反推故障期峰值。
3. 补证：确认 /auth/lab/server-fault 调用方与端点暴露范围
前提：人工具备网关或访问日志查询权限
查询该路径在 03:40 前后 30 分钟的访问日志、来源 IP 与 UA；核对 lab-fault-fixture.jar 是否应部署于当前环境。只读，不改动实例。
预期：明确调用方为演练平台还是真实流量，并确认端点是否应暴露。
风险：只读查询无变更风险；日志保留期不足可能查不到。

<font color="comment">模型自评 60%，不是准确率</font>

编号：inc-9de4676b-84e7-4f9e-8160-b10c44f182b9
```

## jvm-heap-oom

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。3304 bytes
- mitigationVisible fail。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### order-service-本地演练-20261004-053012-36c038 诊断完成
**应用在Drill.exhaustHeap路径上持续分配对象直至JVM堆耗尽；堆上限与分配逻辑未取证，可能为演练构造的堆溢出。
容器内存上限512MiB相对JVM堆需求可能偏紧并加剧堆OOM，但无-Xmx配置证据，无法确认。**
机器：local-dev
时间：10月4日 13:30（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
JFR事件jvm.oom记录java.lang.OutOfMemoryError: Java heap space，栈顶为Drill.exhaustHeap(Drill.java:285)，事件时间05:30:25.213Z。
docker.logs可见相同OOM异常文本与栈帧，其后出现Allocation work completed; retained memory released；该日志为截断投影（原19行，保留3段），不能视为完整故障窗口。
容器Running、OOMKilled=false、ExitCode=0、RestartCount=0，内存限制512MiB，NanoCpus=2e8；仅排除容器被OOM kill，不能排除JVM堆OOM。
主机内存使用率约9.37%，事件前后jdk.CPULoad的jvmUser/machineTotal在0附近至约5%，未见故障期CPU压力；该指标按机器CPU归一化，不等于容器配额百分比。
docker.stats采样于事件后约60秒，区间CPU增量约8.3%单核（非容器配额百分比），memory usage约206MB/limit 512MiB，未反映故障峰值或OOM前内存轨迹。

**未知**
JVM实际堆参数(-Xmx/-Xms)与容器512MiB上限的匹配关系未知，无法判断堆上限是否过小。
Drill.exhaustHeap是否为演练专用代码及是否代表真实业务分配路径未知，业务影响面待确认。
故障前后完整内存与GC轨迹缺失：stats仅在事件后约60秒采样一次，日志为截断投影，未知峰值与持续性。

**下一步**
1. 修复（需批准）：order-service-本地演练-20261004-053012-36c038的堆配置或Drill.exhaustHeap分配逻辑
前提：已获得JVM堆参数和GC数据；已确认最大堆与容器512MiB限制的关系；已完成人工审批
若确认为堆配置不足，在保留容器内存余量前提下调整-Xmx并重启，回滚方案为恢复原参数；若为分配逻辑问题，则修改Drill.exhaustHeap的分配。未确认前不得改为猜测值。
预期：OOM不再出现，堆使用稳定低于上限。
风险：重启导致服务中断；参数过大可能引发容器OOM kill。
2. 验证：修复后容器JFR事件与docker.logs/堆使用
前提：修复已实施；已设定观察窗口
观察JFR是否再出现jvm.oom，核对docker.logs无OutOfMemoryError、docker.stats堆使用稳定低于上限。
预期：观察窗口内无新OOM事件，堆使用稳定。
风险：观察窗口不足可能漏掉低频OOM。
3. 补证：order-local-drill-20261004-053012-36c038容器的JVM堆参数与GC/堆轨迹
前提：容器仍在运行或可重启（当前Running=true）；docker与jcmd/jinfo可用
采集docker.stats与docker.inspect，并通过jcmd/jinfo或容器启动命令确认实际-Xmx/-Xms与堆使用情况；若jcmd不可用，改用-XX:+PrintFlagsFinal日志。
预期：获得堆上限、已用堆与GC压力，区分堆配置不足与分配过多。
风险：只读操作风险低；jcmd可能短暂停顿JVM。

<font color="comment">模型自评 60%，不是准确率</font>

编号：inc-5de24141-0b2e-4414-9152-4020455d05ff
```

## cpu-quota-burst

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。3285 bytes
- mitigationVisible pass。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### order-service-本地演练-20261004-053526-be8ec9 诊断完成
**容器启动初期JIT/初始化活动或单次JFR采样抖动导致瞬时CPU读值升高并触发告警，非持续压力。
未被采样覆盖的秒级短时突发负载（线程争用、GC或业务请求）发生于事件前后，触发源暂无证据定位。**
机器：local-dev
时间：10月4日 13:35（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
05:35:40 jdk.CPULoad 单点 jvmUser=0.194、jvmSystem=0、machineTotal=0.205，按机器10核归一化，未达饱和。
容器 running、OOMKilled=false、RestartCount=0、NanoCpus=2、CpuQuota=0、内存111MB/512MB；宿主load1=0.01、10核。
docker.stats两次区间CPU增量差异大(约1.9核与约0.09核)，均在事件之后，不能反推事件时刻负载；日志仅前12/74行，05:35:29-39采样jvmUser≤0.012。

**未知**
告警阈值与判定字段(jvmUser或machineTotal)及持续时长未知。
事件前后秒级CPU序列不完整，docker.logs仅保留前12/74行，无法确认是否存在短暂尖峰。
未采集cgroup throttling及JFR线程/GC事件，无法区分抖动与真实CPU争用。

**下一步**
修复尚未确定。
1. 止损（需批准）：维持容器现有 NanoCpus=2/内存限额，不做重启或扩缩容
前提：补证尚未显示持续高CPU或throttling；任何配额或重启变更需人工审批
在补证与验证完成前保持现状并持续观察；若确认持续压力，再经审批评估线程/GC治理或配额调整，操作须含回滚方案。
预期：避免基于单点信号误改配置；真实压力时进入受控修复流程。
风险：若压力真实持续，延迟处置可能影响请求延迟。
2. 验证：补采后CPU序列与throttling的判定结果
前提：已获取覆盖事件的秒级CPU与throttling数据；观察窗口≥10分钟
比对补采曲线与JFR读数：若持续接近配额或多核饱和且throttling>0，升级为真实CPU压力；若仅孤立尖峰、throttling=0且10分钟内不复现，定性为瞬时抖动并保留原始数据后关闭告警。
预期：明确事件性质并决定升级或关闭。
风险：误判可能掩盖真实压力，须保留原始数据备查。
3. 补证：order-local-drill-20261004-053526-be8ec9 与 local-dev 的秒级CPU/线程证据
前提：保持容器运行，不重启以免丢失现场
人工按秒级连续采集 docker.stats、host.load 与容器 cgroup cpu.stat(nr_throttled/throttled_time) 至少2-5分钟，并抓取 jstack 与 JFR 线程/GC事件，按原始时间戳与事件时刻对齐。
预期：获得覆盖事件时刻的CPU与throttling序列及线程栈，可区分瞬时抖动与持续压力。
风险：采样开销小；若容器重启或迁移会丢失现场。
4. 补证：jvm.cpu_pressure 告警规则与 jdk.CPULoad 采集配置
前提：具备告警规则与采集配置只读访问
核对判定字段、阈值、持续时长与采样周期，确认是否因单点越阈触发及是否需要调整规则。
预期：明确告警语义；若为单点阈值则标注规则风险。
风险：只读操作，无变更风险。

<font color="comment">模型自评 50%，不是准确率</font>

编号：inc-e1812212-8894-4d23-87c8-9fc82977044c
```

## tag-group-502

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。2627 bytes
- mitigationVisible fail。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### data-asset-service 诊断完成
**应用层pageTagGroup第106行存在未捕获运行时异常，具体触发逻辑未知，需源码或完整调用链证据确认，不能据此认定依赖或数据故障。**
机器：test-svc-02
时间：10月20日 09:21（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
JFR记录business.error，exceptionClass=java.lang.RuntimeException，message为Unhandled request exception，栈首帧为TagAdminBizServiceImpl.pageTagGroup(TagAdminBizServiceImpl.java:106)。
容器日志显示同一时刻该POST请求deptId=5,current=1,size=10返回code=502、msg=系统异常、success=false，耗时25ms；日志truncated=true，仅保留4行，未见异常message与cause。

**未知**
第106行具体代码逻辑与异常message缺失，无法区分参数校验、结果映射或下游调用失败。
日志截断，缺失完整cause链，无法判断是否为包装后的依赖异常。
仅1次事件、耗时25ms，是否稳定复现或与特定deptId数据相关未知。

**下一步**
修复尚未确定。
1. 验证（需批准）：POST /api/v1/tag/admin/tag-group/page，参数deptId=5,current=1,size=10
前提：已完成日志与源码补证；在测试环境非生产流量窗口执行
由人工在受控环境复现该请求，记录响应码与异常栈并与补证结论对比；修复后同参数复测，确认success=true且无异常栈。
预期：复现或排除该参数触发异常，验证修复有效。
风险：可能再次触发异常并产生错误日志，须限测试节点。
2. 补证：data-asset-service / test-svc-02 该时间窗口完整容器日志
前提：具备主机或容器日志读取权限；确认日志轮转未覆盖2026-10-20T01:21:43窗口
拉取01:21:43前后完整日志（非模型截断视图），提取RuntimeException的message与全部Caused by链，统计重复出现次数及涉及参数。
预期：获得完整异常原因链与出现次数，可区分数据相关异常与依赖异常。
风险：只读操作风险低；若日志已轮转则无法回溯。
3. 补证：TagAdminBizServiceImpl.java 第106行及调用链
前提：具备代码仓库读取权限；确认部署版本与所查分支一致
查看pageTagGroup第106行实现及其条件判断、结果映射和外部调用，确定哪类输入走到抛异常分支，并与完整栈对照。
预期：明确触发条件及应修复代码还是修正数据。
风险：只读查阅风险低；版本不一致结论可能失真。

<font color="comment">模型自评 45%，不是准确率</font>

编号：inc-tag-group-502
```

## sop-404

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。2874 bytes
- mitigationVisible fail。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### data-asset-service 诊断完成
**下游或网关未注册/未暴露 /open/api/lx/findPublishYesterday（路径变更、版本未同步或路由规则缺失），Feign 调用返回 404 且业务层未处理上抛。
应用侧调用路径或方法契约与实际下游接口不一致（含 base URL 指向测试代理），缺少配置与源码无法验证。**
机器：test-svc-02
时间：10月20日 09:56（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
JFR 显示 business.error，异常 feign.FeignException$NotFound，operation=GET /api/v1/sop/yesterday-publish，栈指向 SopController.java:50 与 SopBizServiceImpl.java:34。
可见日志显示 Feign 以 POST 调用 https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday，体 {"sysType":10}，返回 [404] 并抛出 FeignException$NotFound。
docker.logs 标记 truncated，仅保留 4 行原始片段，不能代表完整故障窗口，也无法判断单次或持续。

**未知**
下游服务实际暴露的路径与版本未知，404 可能来自网关或下游应用。
Feign 客户端配置（baseUrl、path、超时、降级）与运行版本源码未取得，触发逻辑未知。
故障持续性与影响范围未知，仅见单次事件。

**下一步**
修复尚未确定。
1. 验证（需批准）：修复后 /api/v1/sop/yesterday-publish 单次受控调用
前提：路由或路径修正已完成且下游契约确认；业务方在受控窗口发起一次真实请求
人工受控复现一次 GET 请求，采集响应码与日志；http.probe 不支持该业务 POST，不作等价复现。失败则回滚配置并保留日志。
预期：返回非 404 且日志无 FeignException$NotFound 未处理异常。
风险：下游如有写入副作用需先评估；变更需可回滚。
2. 补证：proxy-test 网关对 /open/api/lx/findPublishYesterday 的路由配置与下游服务接口清单
前提：取得访问 proxy-test 网关配置与下游接口文档的授权
只读核对网关路由目标、后端是否注册该 POST 路径及当前版本接口清单，与 SopFeignClient 声明的方法路径/版本比对，记录结论。
预期：确认 404 来自网关无路由还是下游无该接口，并记录正确路径/版本。
风险：只读核查风险低；不得顺带修改配置以免影响其他调用方。
3. 补证：SopBizServiceImpl:34、SopController:50 同版本源码及 Feign 客户端配置
前提：取得与 test-svc-02 运行版本一致的源码包
阅读两点代码，确认调用路径是否硬编码、有无 try/catch 或降级分支，以及异常如何映射为接口响应。
预期：明确触发分支与是否需补降级/统一异常处理，区分两个候选原因。
风险：只读代码风险低。

<font color="comment">模型自评 45%，不是准确率</font>

编号：inc-sop-404
```

## health-503

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。2554 bytes
- mitigationVisible fail。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### data-asset-service 诊断完成
**服务实例或容器未就绪/异常退出或重启循环，导致健康端点返回 503；缺少容器状态与日志证据，尚未确认。
健康端点内部检查（启动检查或依赖探活）未通过并主动返回 503，或由代理/入口生成 503；触发逻辑未知，需读代码与日志确认。**
机器：test-svc-02
时间：10月20日 10:00（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
健康探测 GET https://svc.example/health 返回 503，healthy=false，延迟 30ms，说明该健康端点当前判定为不健康且响应迅速；同一时刻无其他证据。

**未知**
503 由应用代码主动返回还是由代理/入口生成，未知。
容器运行状态、重启次数与退出码未知；运行中容器不能证明 JVM 健康。
是否伴随 CPU/内存压力或依赖超时未知；未知峰值与持续性需补采。

**下一步**
修复尚未确定。
1. 验证（需批准）：健康端点 https://svc.example/health
前提：补证完成且已确定候选原因；如需重启/发布已获人工审批并有回滚方案
在受控条件下再执行一次 GET /health 并记录状态码、延迟与日志时间戳；若做了修复或重启，恢复后同样复测一次。
预期：确认 503 是否持续，以及修复后端点是否恢复为健康。
风险：单次探测流量极小；若涉及重启或发布存在短时不可用风险。
2. 补证：节点 test-svc-02 上承载 data-asset-service 的容器
前提：确认该节点上容器标识与运行实例
只读采集 docker.inspect（状态、重启次数、退出码、健康检查配置）、docker.logs 实际可见片段、docker.stats 与 host.memory/host.load，按事件时间 02:00:00Z 对齐分析。
预期：获取容器状态与资源基线，区分容器未就绪、重启循环与资源压力。
风险：只读操作风险低；日志可能含敏感信息，仅限内部使用。
3. 补证：data-asset-service 健康端点实现与同期日志
前提：具备代码与日志访问权限
阅读健康端点源码，列出返回 503 的所有条件分支（启动检查、依赖探活等），并与 docker.logs 中同期异常类、文本及抛出位置对照，确定实际触发分支。
预期：确定 503 由哪段逻辑或哪项依赖产生；若代码分支与日志不一致则回到容器层排查。
风险：只读分析，风险低。

<font color="comment">模型自评 30%，不是准确率</font>

编号：inc-health-503
```

## stack-overflow

状态为 completed。

- evidenceIdsValid pass。
- requiredKindsCited pass。
- conflictPreserved not_applicable。
- missingEvidenceValid pass。
- capabilityBoundary pass。
- uncertaintyDiscipline not_applicable。
- structuredDiagnosis pass。
- actionsComplete pass。
- citationsExist pass。
- forbiddenAttributionScreen pass。固定断言模式筛查，不代表语义上不存在禁止归因。
- messageWithinLimit pass。3393 bytes
- mitigationVisible fail。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### data-asset-service 诊断完成
**com.example.Recurse.down 调用路径的递归终止条件缺失或无法达到，栈深度持续增长；触发输入与代码条件尚未验证。
异常文本只证明栈溢出发生，无法区分业务数据触发深递归，还是部署版本差异、JVM栈大小配置等因素；需源码与部署信息确认。**
机器：test-svc-02
时间：10月20日 10:05（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**依据**
日志出现 java.lang.StackOverflowError，并以 com.example.Recurse.down(Recurse.java:7) 重复栈帧结束，失败点在该递归方法附近。
日志 truncated=true 仅保留3行，看不到上层调用栈、业务入口或递归终止条件代码。
缺少容器资源统计、主机负载与内存证据，无法评估故障窗口内CPU、堆或限额压力；运行中容器不代表JVM健康。

**未知**
完整异常栈与线程上下文缺失，递归入口和触发参数未知。
该服务部署版本、JVM -Xss 等栈参数和 Recurse 源码未提供，无法确认终止条件缺陷或配置问题。
容器限额与故障窗口内CPU、内存、throttling情况未知。

**下一步**
1. 修复（需批准）：com.example.Recurse.down 的递归终止逻辑与调用入口
前提：已取得与部署一致源码并确认触发输入；变更已通过代码评审与人工审批；具备旧版本回滚包
在受控环境用已记录触发输入复现并验证缺陷；修正终止条件或限制递归深度，经代码评审后灰度发布，保留回滚。
预期：递归深度受控，不再出现StackOverflowError，业务结果符合预期。
风险：修改递归逻辑可能改变边界结果；灰度不足会扩大影响。
2. 验证（需批准）：修复后 data-asset-service 实例的日志与健康探测
前提：修复版本已部署到测试实例；已配置健康URL
运行受控复现用例与正常业务流量，检查日志无StackOverflowError，并执行http.probe GET/HEAD健康检查；对比修复前后错误计数。
预期：异常不再复现，健康探测成功，关键业务路径结果正常。
风险：测试流量可能触发其他分支；健康探测不代表全链路业务正常。
3. 补证：data-asset-service@test-svc-02 的容器与主机运行时快照
前提：确认容器仍存在且 docker stats 可读取；仅执行只读命令，不影响业务
采集 docker.inspect（含Env、Cmd、Cpu/Memory限额）、docker.stats、host.load、host.memory，并拉取同时段未截断docker.logs，按原始时间对齐。
预期：获得部署参数、资源限额、主机压力与完整异常栈，用于区分递归逻辑与资源诱发。
风险：只读命令带来轻微负载；容器已退出则信息可能缺失。
4. 补证：与当前部署版本一致的 Recurse 源码及调用链
前提：已确认实际部署版本或镜像tag；只读取代码与配置，不改动
定位 Recurse.down 与全部调用方，检查递归终止条件、入参校验和栈大小配置，并核对异常栈中的入口方法；若无源码则记录缺口。
预期：确认是否存在可达的终止条件缺陷或配置不符，明确触发路径。
风险：版本不一致将导致误判；需以部署元数据核对。

<font color="comment">模型自评 50%，不是准确率</font>

编号：inc-stack-overflow
```
