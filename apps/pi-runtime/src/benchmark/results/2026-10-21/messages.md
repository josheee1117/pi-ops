# 真实模型值班消息评测

以下消息来自 agent 渲染器的 fake fetch 捕获，没有外发。自动通过不等于能推进恢复。

| 案例 | 模型 | thinking | 输入 token | 输出 token | 耗时 ms | 消息字节 | 自动结果 |
|---|---|---|---:|---:|---:|---:|---|
| dataasset-197 | ark/deepseek-v4.1-flash | off | 3239 | 8192 | 55175 | 未生成 | 未通过 |
| jvm-heap-oom | ark/deepseek-v4.1-flash | off | 7677 | 16384 | 106071 | 未生成 | 未通过 |
| cpu-quota-burst | ark/deepseek-v4.1-flash | off | 4589 | 16384 | 90333 | 未生成 | 未通过 |
| tag-group-502 | ark/deepseek-v4.1-flash | off | 1668 | 8192 | 46667 | 未生成 | 未通过 |
| sop-404 | ark/deepseek-v4.1-flash | off | 4426 | 15217 | 89090 | 未生成 | 未通过 |
| health-503 | ark/deepseek-v4.1-flash | off | 1363 | 8192 | 51192 | 未生成 | 未通过 |
| stack-overflow | ark/deepseek-v4.1-flash | off | 6383 | 21260 | 120111 | 3678 | 通过 |

## dataasset-197

状态为 failed。all specialists failed

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
```

## jvm-heap-oom

状态为 failed。all specialists failed

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
```

## cpu-quota-burst

状态为 failed。all specialists failed

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
```

## tag-group-502

状态为 failed。all specialists failed

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
```

## sop-404

状态为 failed。model output is not valid JSON

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
```

## health-503

状态为 failed。all specialists failed

未形成报告，自动内容检查未执行，不能计为通过。

### 最终消息原文

```text
未生成最终消息。没有结构化报告，未调用企微渲染器。
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
- messageWithinLimit pass。3678 bytes
- mitigationVisible pass。
- repairOrUnknownVisible pass。
- verificationVisible pass。

### 最终消息原文

```text
### data-asset-service 诊断完成
**Recurse.down 的递归终止条件缺失、错误或递归深度未受控，是当前最直接候选原因。
特定输入或调用路径触发异常递归深度；当前证据只显示递归帧，不能确认具体入口和触发数据。
线程栈大小配置偏小或版本相关默认值较低可能降低溢出阈值；这是待验证的放大因素，不是已确认根因。**
机器：test-svc-02
时间：10月20日 10:05（北京时间）
诊断原文时间按 UTC 阅读；显式时区以原文为准。

**下一步**
修复尚未确定。
1. 止损（需批准）：data-asset-service 故障实例（test-svc-02）
前提：确认实例仍不可用且影响业务；已尽量保留现场日志和线程转储；获得人工审批并确认流量摘除或滚动策略
经人工审批后对故障实例执行受控重启以临时恢复可用性；重启前采集日志和线程转储，重启后观察是否再次出现 StackOverflowError。若立即复发则停止重启循环并回到代码/参数排查。回滚要求：保留原实例配置，按发布流程回退到上一可用实例。
预期：临时恢复可用性并保留复发证据；不消除递归根因。
风险：重启可能造成短时不可用、请求失败或现场丢失；可能再次溢出。
2. 验证（需批准）：修复后的 data-asset-service 与 Recurse.down 调用路径
前提：已完成代码或配置变更并部署到验证环境；具备可复现的可疑输入或监控窗口；受控复现已获得审批并限制影响范围
在隔离或灰度环境用可疑输入进行受控复现，检查日志不再出现 StackOverflowError 和同一方法帧；生产验证只做已审批的观测与已配置健康 URL 的 GET/HEAD 健康检查，不将 http.probe 当作业务 POST 复现。结果分支：若复现成功且无溢出，记录修复有效；若仍溢出，保留新栈并重新定位递归入口。
预期：确认修复对目标递归路径有效，或获得新的失败栈用于继续定位。
风险：受控复现可能再次触发溢出；需限制影响范围并准备回滚。
3. 补证：data-asset-service 容器（test-svc-02）完整日志与线程转储
前提：具备容器日志和线程转储采集权限；按原始时间窗口采集并保留脱敏要求；确认目标实例与故障实例一致
人工采集故障时间点前后完整容器日志和线程转储，确认线程名、完整异常栈、相邻业务日志及是否存在多个线程或多个入口。不要用当前 3 行截断视图代替完整日志。结果分支：若完整栈仍仅重复 Recurse.down，则优先查该递归边界；若出现其他入口或伴随异常，则并行排查对应调用链。
预期：获得可区分递归入口、线程范围和伴随异常的完整日志与线程转储证据。
风险：日志和线程转储可能含敏感信息，需脱敏；只读采集不影响业务。
4. 补证：data-asset-service 容器配置、镜像版本与启动参数
前提：具备 docker inspect 或等效配置读取权限；确认目标容器实例与故障实例一致
读取容器环境变量、镜像/版本、CPU/内存限制和启动命令，重点查找 -Xss、JAVA_TOOL_OPTIONS、JAVA_OPTS 等线程栈线索。结果分支：若发现较小且明确的栈参数，记录为放大因素候选；若未发现，不能据此认定栈大小正常。
预期：确认容器/JVM 参数和版本，判断线程栈大小配置是否为候选放大因素。
风险：只读检查，风险低；避免输出敏感环境变量值。
另有 2 条动作见完整诊断（编号 captured-report）

编号：inc-stack-overflow
```
