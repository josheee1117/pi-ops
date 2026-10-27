# 线上原配置闭环

## 结论

7 例都跑完了。裁判 7/7 闭环。花费 320182 token，预算 400000。耗时 1113887 毫秒，约 18.6 分钟。

只有 health-503 降成「诊断不完整」。它的裁判仍然闭环，messageHardPass 是 false。其余 6 例没有降级，messageHardPass 都是 true。

诊断是火山 ark/deepseek-v4.1-flash，处理是 cpa/deepseek-flash-latest，裁判是 cpa/glm-latest。这和第 18、19 单是同一套配置。和 r3-live 的 3 例是同一个 deepseek v4.1 flash，上游不同。r3-live 走 agentrouter，本批走火山。

## 修复类别

已跑且未降级的 6 例都没有 purpose=repair，诊断摘要自己写了「修复尚未确定」。health-503 是降级模板，不计入这三类。短消息里那句「修复尚未确定」是渲染补上的。

| 类别 | 数量 | 案例 |
|---|---:|---|
| 模型给的真实修复办法 | 0 | 无 |
| 模型写的「修复尚未确定」 | 6 | 除 health-503 外的 6 例 |
| 渲染兜底 | 0 | 无 |
| 降级模板，另计 | 1 | health-503 |

## 七例结果

| 案例 | 闭环 | messageHardPass | 失败项 | 修复类别 |
|---|---|---|---|---|
| dataasset-197 | closed | true | 无 | 模型写的「修复尚未确定」 |
| jvm-heap-oom | closed | true | 无 | 模型写的「修复尚未确定」 |
| cpu-quota-burst | closed | true | 无 | 模型写的「修复尚未确定」 |
| tag-group-502 | closed | true | 无 | 模型写的「修复尚未确定」 |
| sop-404 | closed | true | 无 | 模型写的「修复尚未确定」 |
| health-503 | closed | false | 无 | 降级模板，另计 |
| stack-overflow | closed | true | 无 | 模型写的「修复尚未确定」 |

health-503 的失败项为空，是因为闭环失败项来自裁判，裁判 8 项都过了。messageHardPass 失败是因为 hypothesis 以「诊断不完整」开头，自动检查把降级判 fail。

## 恢复建议原文

jvm-heap-oom、health-503、stack-overflow 的第 1 条是止损。cpu-quota-burst 的止损在第 3 条，没有被未知说明替换。dataasset-197、tag-group-502、sop-404 的短消息没有止损句。处理回答里有止损，裁判的 stop_loss 也过了。这不是渲染把已有止损挤掉。诊断摘要没把止损写进三条恢复建议，短消息照摘要渲染。

dataasset-197：

```text
恢复建议：
1. 修补前先补证：读 LabFaultController.java:25 源码并统计该接口请求量与错误率，确认调用来源与影响面。
2. 修复尚未确定：依据源码判断是硬编码异常还是入参触发，再决定移除接口、加访问控制或修正逻辑，发布需人工审批并准备回滚。
3. 补证后复核关键业务接口错误率与用户报障，确认影响范围。
```

jvm-heap-oom：

```text
恢复建议：
1. 人工批准后隔离故障容器流量或重启止损，保留日志与堆转储
2. 采集JVM堆与GC指标及故障窗口内存曲线，区分堆上限不足与瞬时大分配
3. 核对故障窗口请求错误率与用户报障，确认业务影响；修复尚未确定，需先取源码与堆分析定位
```

cpu-quota-burst：

```text
恢复建议：
1. 核对 2026-10-04T05:35 前后请求错误率、关键接口结果与用户报障，确认业务影响
2. 修复尚未确定：先拉取完整日志与连续 docker.stats 及 throttling 数据，据此区分单点毛刺与持续压力
3. 若确认持续高压，经审批并备回滚后隔离流量、限制触发任务或扩容，并验证 CPU 与错误率回落
```

tag-group-502：

```text
恢复建议：
1. 先补证：拉取未截断日志与源码确认根异常类型。
2. 修复尚未确定，需根据根异常与第106行代码分支确定修复方向。
3. 验证：统计故障窗口接口错误率并核查用户报障。
```

sop-404：

```text
恢复建议：
1. 补证：拉取完整日志与 404 响应体，核对 Feign 基址和路径配置。
2. 修复尚未确定：以 404 响应体与配置比对结果决定是对端路径变更还是调用方配置错误。
3. 验证：人工受控复现，并核对错误率与用户报障。
```

详情里有 mitigation，操作是审批后为 findPublishYesterday 增加异常捕获、降级返回或临时熔断。短消息没写这一条。

health-503：

```text
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：修复：核对健康检查响应、应用日志和依赖状态。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
```

第 1 条止损还在。第 2 条的「修复尚未确定」前缀是渲染补的，降级模板原文是「修复：核对健康检查响应、应用日志和依赖状态。」

stack-overflow：

```text
恢复建议：
1. 经批准摘流故障实例或暂停疑似触发入口
2. 修复尚未确定，先补采完整日志、容器状态与对应源码
3. 验证异常不再新增并核对请求错误率与用户报障
```

## 与第 18、19 单和 r3-live 对比

第 18 单是 `2026-10-22-closed-loop`。第 19 单只重跑了 CPU 和 OOM。旧 messageHardPass 用第 19 单离线重评。r3-live 是 agentrouter 上的同模型，只跑了 3 例。

| 案例 | 第 18 单 | 第 19 单 | r3-live | 本轮 |
|---|---|---|---|---|
| dataasset-197 | closed，消息检查 false | 未重跑 | closed，消息检查 true | closed，消息检查 true，短消息无止损句 |
| jvm-heap-oom | closed，消息检查 false | closed，消息检查 false | closed，消息检查 true | closed，消息检查 true |
| cpu-quota-burst | open | closed | open，no_forbidden | closed |
| tag-group-502 | closed，消息检查 false | 未重跑 | 未跑 | closed，消息检查 true，短消息无止损句 |
| sop-404 | closed，消息检查 false，缺止损 | 未重跑 | 未跑 | closed，消息检查 true，短消息无止损句 |
| health-503 | closed，未降级 | 未重跑 | 未跑 | closed，但诊断降级 |
| stack-overflow | closed，消息检查 true | 未重跑 | 未跑 | closed，消息检查 true |

CPU 相对 r3-live 从 open 回到 closed。处理回答写了源码夹具有 /cpu 端点，同时写「不能据此判定为演练、误报或预期行为」。第 19 单也是 closed。这是同模型、不同上游的差异，不是诊断降级。

## 降级单列

health-503 是本批唯一的「诊断不完整」。第 18 单这一例没有降级。两次 coordinator 调用都是 stop，返回了 JSON。最后一次把 scene、whatHappened、severity、recovery 放在 diagnosis 下面，没有 diagnosis.summary。结构化校验没过，装置改用降级模板。证据是 health-503.json 的 modelCalls 最后一条和 result.diagnosis.report.hypothesis。

## 命令、花费、耗时

探针在 14:10 左右。诊断 12 token，处理 50 token，裁判 74 token，都返回 OK。正式跑次从探针之后开始，装置记录 1113887 毫秒。

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/results/2026-10-22-closed-loop-r3-prod/probe-models.ts
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --handler cpa/deepseek-flash-latest --judge cpa/glm-latest \
  --case <id> --budget <剩余> --resume \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r3-prod
```

没有传 `--config` 和 `--agent-catalog`，用的是 CLI 默认值。没有用 `/tmp/pi-ops-r3-live/diagnosis.env`。没有 429 或 503，没有换上游。

| 案例 | 诊断 | 处理 | 裁判 | 合计 | 耗时 ms |
|---|---:|---:|---:|---:|---:|
| dataasset-197 | 15508 | 8983 | 18043 | 42534 | 177512 |
| jvm-heap-oom | 43107 | 17597 | 25189 | 85893 | 288066 |
| cpu-quota-burst | 37573 | 18371 | 21823 | 77767 | 228746 |
| tag-group-502 | 13100 | 6132 | 9129 | 28361 | 105639 |
| sop-404 | 13704 | 5960 | 8627 | 28291 | 84676 |
| health-503 | 12077 | 4721 | 7872 | 24670 | 89356 |
| stack-overflow | 17075 | 6077 | 9514 | 32666 | 129149 |

## 新坑 / 决定

1. health-503 的模型 JSON 把摘要字段摊在 diagnosis 上，校验失败后变成降级模板。证据是 health-503.json 最后一次 coordinator 输出的键，以及保存报告以「诊断不完整」开头。决定单列，不把它算进三类修复计数。
2. 三例短消息没有止损句，但裁判 stop_loss 通过。证据是 dataasset-197、tag-group-502、sop-404 的 summary.recovery 和处理回答 actions。决定照实写，不说止损被挤掉。
3. 结果目录里的 probe-models.ts 会进 tsc。跑完后的 typecheck 通过，没有 TS 错误。决定留下这份能通过类型检查的探针，不留会报错的脚本。
