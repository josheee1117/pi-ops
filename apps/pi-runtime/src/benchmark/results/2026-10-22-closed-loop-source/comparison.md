# 源码片段七例与第 24 单对照

2026-10-26 14:19 后使用线上原配置执行。诊断为 `ark/deepseek-v4.1-flash`，处理为 `cpa/deepseek-flash-latest`，裁判为 `cpa/glm-latest`，thinking 均请求 off。没有更换上游。七例全部运行，累计 316807 token，其中额度探测 112，整链路 316695，未超过 400000。`live-status.json` 的 stopped 为 null。

本次运行基于修复提交 `da8d9c7`。结果检查发现模型改写注解空格后仍可逐字保留源码，追加提交 `111c206` 修复清理规则，并对已保存的两处文件作相同删除。不重跑模型、不重判、不改诊断分类或 token 数。

## 逐例结果

旧结果来自 `../2026-10-22-closed-loop-r3-prod/summary.json`。闭环是处理 agent 和裁判的判定。修复类别只看诊断动作，必须有 purpose=repair、引用源码 id，并在操作文本里有片段独有事实。处理 agent 后续读取完整夹具给出的方案不算诊断的真实修复。

| 案例 | 旧闭环 | 本次闭环 | 旧 messageHardPass | 本次 messageHardPass | 旧修复类别 | 本次修复类别 | 本次 token |
|---|---|---|---|---|---|---|---:|
| dataasset-197 | closed | closed | true | true | 修复尚未确定 | 修复尚未确定 | 52026 |
| stack-overflow | closed | closed | true | true | 修复尚未确定 | 修复尚未确定 | 27731 |
| jvm-heap-oom | closed | closed | true | false | 修复尚未确定 | 兜底 | 75002 |
| cpu-quota-burst | closed | closed | true | true | 修复尚未确定 | 修复尚未确定 | 85056 |
| tag-group-502 | closed | closed | true | true | 修复尚未确定 | 修复尚未确定 | 24107 |
| sop-404 | closed | closed | true | true | 修复尚未确定 | 修复尚未确定 | 24905 |
| health-503 | closed | closed | false | true | 兜底 | 修复尚未确定 | 27868 |

结论是闭环仍为 7/7，messageHardPass 仍为 6/7，真实修复仍为 0/7。本次健康 503 不再降级，但堆 OOM 降级。只有一轮样本，不能据此宣称整体质量提高或降低。

## DataAsset 修复动作与版本状态

交付诊断没有 `purpose=repair` 动作，不能贴出不存在的修复动作原文。诊断有两条补证和一条验证。与修复对象直接相关的补证 operation 原文是：

> 检查容器环境变量、spring.profiles.active 与 lab.fault.enabled 实际值，取出运行包 lab-fault-fixture.jar 中 LabFaultController 与源码快照比对第25行。

其 expectedResult 原文是：

> 确认该端点是否在当前部署注册启用；一致则修复对象为控制器或启用配置，不一致则重新定位版本差异。

hypothesis 明确写“源码快照版本未核对”，uncertainties 明确写“版本未核对：source.snippet 的 versionStatus=unchecked”。版本警告通过。源码已让诊断指出实际 profile 和开关名，但模型仍要求核对运行版本，未输出结构化修复。

## 栈溢出修复动作与版本状态

交付诊断同样没有 `purpose=repair` 动作。推荐文本里与修复相关的原文是：

> 修复尚未确定：若核对版本后确认该方法即运行代码且无终止条件，则为其加入终止条件或深度上限并回归验证；若运行版本不一致或存在限深逻辑，则另查触发源。

这段属于 recommendation，不属于修复动作，所以分类仍为 undetermined。hypothesis 明确写“versionStatus=unchecked（版本未核对）”，观察里也写“版本未核对”。版本警告通过。

## 异常与正文检查

- JVM 堆 OOM 的两名专家均发生 `specialist cited evidence that does not belong to the current incident`。模型调用有 token、没有上游 stopReason=error，但报告降级为“诊断不完整”，messageHardPass=false。证据在 `jvm-heap-oom.json` 的 diagnosis、原始 modelCalls，以及本地 `live-jvm-heap-oom.log`。本单不修改 coordinator 或证据引用规则。
- 结果文件不保存 source.snippet.text。模型逐字引用的代码行以 `[source omitted]` 代替，修复方向、引用 id、路径、版本说明和评分保留。
- 真实运行发现 DataAsset 专家输出把源码注解参数的空格去掉。追加回归先失败，再通过。`111c206` 扩展清理以匹配来源片段中的注解名，清理结果 JSON 与 summary 中的两类引用。
- `stop.json` 保留上午额度未恢复时的历史阻断记录，本次状态以 `live-status.json` 为准。

## 本地验证证据

读取器七条新回归先失败，修复后 agent 436 项通过。评测落盘回归、模型回显回归和注解格式回归均先失败后通过。最终 runtime 115 项通过，原有可选 SDK smoke 1 项跳过。两个应用 typecheck 与 pnpm build 通过。

红绿日志在 `/Users/hejiayuan/.cache/verify-evidence/pi-ops/20261026-snippet-review/`。不带 `--no-build` 的构建与健康故障演练证据在 `/Users/hejiayuan/.cache/verify-evidence/pi-ops/20261026T044057Z-8393/`。FAKE 模型完成一次调查、Incident 恢复、两条本地通知 DELIVERED，cleanup 恢复原数据库。该演练不证明真实诊断质量，也没有向真实企微发送消息。
