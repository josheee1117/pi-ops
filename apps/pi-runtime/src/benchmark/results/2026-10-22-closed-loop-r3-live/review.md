# r3 live 重跑

## 结论

40 万 token 上限内只跑完 3 例，没有跑完 7 例。已跑的 3 例都没有降成「诊断不完整」。dataasset-197 和 jvm-heap-oom 闭环，cpu-quota-burst 未闭环。后 4 例没有模型输出，不能记成降级。

诊断和处理都是 `cpa/deepseek-v4.1-flash`，上游是 agentrouter。这和前几批的线上诊断是同一个模型 deepseek v4.1 flash，上游不同。前几批诊断走火山 `ark/deepseek-v4.1-flash`，处理走火山上的 `cpa/deepseek-flash-latest`。对比时按「同模型、不同上游」读，不要当成同一上游的重复抽样。

裁判原定 `cpa/glm-latest`。最小请求返回 429 AccountQuotaExceeded，重置时间 2026-10-22 13:57:43 +0800。改用已探通的 `cpa/gemini-3.8-flash-high`。没有试 `cpa/gemini-4-argon-high`。deepseek 这条上游没有 429，所以没有换成 grok。

## 模型与思考等级

请求的 thinking 都是 off，和生产默认一致。实际发出去的等级不一样。

`~/.pi/agent/models.json` 里 `cpa/deepseek-v4.1-flash` 的 `thinkingLevelMap.off` 是 null。SDK 把不支持的 off 抬到下一个可用等级 low，请求体是 `reasoning_effort=low`。证据是 probe-adapter.json。仓库外临时 catalog 去掉这个 null，并把 compat 设成和生产一样的 deepseek 格式后，请求体出现 `thinking: {type: disabled}`，但回复仍有 67 个思考字符。agentrouter 没有按这个字段关掉思考。因此正式跑次仍用指定的 `~/.pi/agent`，不改用户的全局 catalog。诊断和处理的有效等级是 low，不是线上 ark 的 disabled。

`cpa/gemini-3.8-flash-high` 只支持 high。请求 off 后有效等级是 high。证据是同一份探针里的 judge 记录。

## 花费与耗时

闭环装置记录 333546 token，预算 400000。三例耗时合计 816492 毫秒。第一例 11:13:43 +0800 开始。探针另计 711 token，不在这 333546 里。

| 案例 | 诊断 | 处理 | 裁判 | 合计 | 耗时 ms |
|---|---:|---:|---:|---:|---:|
| dataasset-197 | 45681 | 19685 | 17201 | 82567 | 174376 |
| jvm-heap-oom | 71189 | 23349 | 20791 | 115329 | 265582 |
| cpu-quota-burst | 80906 | 25753 | 28991 | 135650 | 376534 |

跑完 CPU 后剩余 66454。CLI 每例预留 95000，且已完成的最便宜一例是 82567。再开 tag-group-502 会冲破 40 万上限，所以停。stop.json 记录了这个停止点。

## 命令

探针和 dry-run 在仓库外 env `/tmp/pi-ops-r3-live/diagnosis.env` 上确认配置。这份 env 只写了 provider、model 和 thinking，没有火山密钥，避免用 ark key 覆盖 catalog 里的 cpa 凭据。没有改 CLI。

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/results/2026-10-22-closed-loop-r3-live/probe-models.ts cpa/deepseek-v4.1-flash cpa/glm-latest
PROBE_OUT=probe-judge.json PROBE_TIMEOUT_MS=90000 pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/results/2026-10-22-closed-loop-r3-live/probe-models.ts cpa/gemini-3.8-flash-high
pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/closed-loop-cli.ts --live \
  --config /tmp/pi-ops-r3-live/diagnosis.env \
  --agent-catalog "$HOME/.pi/agent" --model-catalog "$HOME/.pi/agent" \
  --handler cpa/deepseek-v4.1-flash --judge cpa/gemini-3.8-flash-high \
  --case dataasset-197 --budget 400000 \
  --out apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r3-live --dry-run
```

正式跑次是同一条 live 命令去掉 `--dry-run`。第一例单独跑。后两例由 `run-live.ts` 按剩余预算续跑，遇到提供方错误或剩余不足 95000 就停。日志在 `live-*.log`。

探针结果：`cpa/deepseek-v4.1-flash` stop，49 token。`cpa/glm-latest` 429，0 token。`cpa/gemini-3.8-flash-high` stop，83 token。

## 七例结果

修复类别只计已跑且未降级的样本。模型给了 purpose=repair，算真实修复。模型自己在恢复建议里写了「修复尚未确定」，算模型未知。消息里这句话是渲染兜底补上的，而诊断原文没有，算渲染兜底。降级模板不计入这三类。

| 案例 | 闭环 | messageHardPass | 失败项 | 修复类别 |
|---|---|---|---|---|
| dataasset-197 | closed | true | 无 | 模型写的「修复尚未确定」 |
| jvm-heap-oom | closed | true | 无 | 模型写的「修复尚未确定」 |
| cpu-quota-burst | open | true | no_forbidden | 模型写的「修复尚未确定」 |
| tag-group-502 | 未跑 | 未知 | 预算停止 | 未取得 |
| sop-404 | 未跑 | 未知 | 预算停止 | 未取得 |
| health-503 | 未跑 | 未知 | 预算停止 | 未取得 |
| stack-overflow | 未跑 | 未知 | 预算停止 | 未取得 |

已跑 3 例都没有 purpose=repair。三类计数：真实修复 0，模型未知 3，渲染兜底 0。3 例的消息恢复建议和诊断 `summary.recovery` 逐字相同，所以未知说明是模型写的，不是 `on-call-brief.ts` 事后补的。

没有一例 hypothesis 以「诊断不完整」开头，degraded 都是 false。

## 恢复建议原文

三例的第 1 条都是止损，第 2 条才是修复未知。止损没有被挤掉。

dataasset-197：

```text
恢复建议：
1. 先经审批在网关拦截该路径并保留回滚。
2. 修复尚未确定：先核对当前源码、映射与启用配置，再决定改动。
3. 验证故障窗口请求错误率、关键接口结果和用户报障。
```

jvm-heap-oom：

```text
恢复建议：
1. 先经批准将故障容器从入口摘除或暂停已确认触发任务，保留现场并准备回滚。
2. 修复尚未确定：先只读核查 Drill.java:285/307 调用与 JVM 堆参数，再定修复方向。
3. 核对故障窗口请求错误率、关键业务请求结果和用户报障。
```

cpu-quota-burst：

```text
恢复建议：
1. 先经批准限流入口或隔离非关键调用，保留回滚，观察延迟和错误率。
2. 修复尚未确定：补采完整日志、连续统计和线程栈，定位占用CPU的线程与任务。
3. 核对故障窗口请求错误率、关键接口结果和用户报障，确认业务影响。
```

## 与第 18、19 单对比

第 18 单闭环来自 `../2026-10-22-closed-loop/`。第 19 单只重跑了 CPU 和 OOM，来自 `../2026-10-22-closed-loop-r2/`。旧 messageHardPass 用第 19 单离线重评，不使用旧标签版的原始值。本轮是同模型、不同上游，裁判也从 glm 换成了 gemini。

| 案例 | 第 18 单闭环 | 第 19 单闭环 | 第 19 单消息检查 | 本轮 |
|---|---|---|---|---|
| dataasset-197 | closed | 未重跑 | false，缺修复或明确未知 | closed，messageHardPass true |
| jvm-heap-oom | closed | closed | false，缺修复或明确未知 | closed，messageHardPass true |
| cpu-quota-burst | open，失败 root_cause、repair、no_forbidden | closed | false，缺修复或明确未知 | open，只失败 no_forbidden |
| tag-group-502 | closed | 未重跑 | false，缺修复或明确未知 | 未跑 |
| sop-404 | closed | 未重跑 | false，缺止损 | 未跑 |
| health-503 | closed | 未重跑 | false，缺修复或明确未知 | 未跑 |
| stack-overflow | closed | 未重跑 | true | 未跑 |

已跑 3 例都没有「诊断不完整」。相对第 19 单，CPU 从 closed 退回 open，这是闭环判定退步，不是诊断降级模板。OOM 和 dataasset 的闭环没有退步。三例 messageHardPass 都从 false 变成 true，因为模型写了明确的修复未知，不是因为检查放宽。

CPU 未闭环的原因在处理 agent，不在诊断。诊断 hypothesis 写的是短时 CPU 压力，线程、任务和业务影响未确认。处理回答写「最可能路径是 /cpu 控制端点在 05:35:40 前后被调用」。裁判 no_forbidden 失败，理由是没有调用日志或审计证据，只凭源码夹具有这个端点，就倾向断言演练或测试触发。第 19 单的处理回答没有把本次定成演练误报，所以当时闭环。本轮没有重判。

## 范围

没有改 CLI，没有改验证技能，没有发企微，没有起 compose 栈。装置用保存的事件和 fake fetch，不是故障产生、采证或真实通知投递。HEAD 上这 6 个被哈希的文件与跑次记录一致。跑次期间另有 3 个提交，没有改这 6 个文件。

## 新坑 / 决定

1. agentrouter 上的 deepseek v4.1 flash 不能按线上方式关掉思考。证据是 probe-adapter.json 的有效等级 low，以及 probe-adapter-disabled.json 在发送 `thinking: {type: disabled}` 后仍有 67 个思考字符。决定正式跑次用指定 catalog，并在结果里写明有效等级是 low。
2. glm-latest 仍在同一条 5 小时额度里，重置时间与上次火山 429 相同。证据是 probe-models.json。决定裁判改用 gemini-3.8-flash-high，不空等重置。
3. 这个上游加 high 思考裁判后，单例 8 万到 13 万 token。证据是三例 json 的 tokens 和 stop.json。决定停在 3 例，不靠绕过 95000 预留去冲第 4 例。
4. CPU 处理 agent 在没有调用证据时把 /cpu 端点写成最可能路径，裁判判 no_forbidden 失败。证据是 cpu-quota-burst.json 的 judge.items。决定保留 open，不重跑到满意，也不把它记成诊断降级。
