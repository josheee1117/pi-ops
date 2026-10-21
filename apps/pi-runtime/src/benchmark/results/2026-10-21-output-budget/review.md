# 输出预算回归修复与真实评测

## 结论

固定的 7 例各跑一次，完整结构化诊断由修复前 1/7 变成 7/7。最终消息由 1/7 变成 7/7，全部不超过 4000 字节。没有发送企微。全部内容检查只通过 2/7，另外 5 例缺少止损类别，不把完整生成当成内容质量全过。

模型仍为 `ark/deepseek-v4.1-flash`，Pi thinking 请求为 `off`。模型不是对照变量。改变的是关闭思考的实际参数、输出预算和提示词长度纪律。结果为每例一次的小样本，不证明稳定成功率，也无法分别量化三个改动的贡献。

## 根因及证据

1. 生产 `deploy/docker/models.json` 与原 lab 模型目录都显式配置 `maxTokens=8192`。原 lab 并非省略该字段，前述默认值假说与现场不符。pi-ai 0.84.2 的 `dist/api/simple-options.js:17` 默认使用 `model.maxTokens` 并按上下文余量裁上限。`request-before.json` 是同一 SDK 经 fake fetch 的请求体，实际发送 `max_completion_tokens=8192`。
2. 原配置 `reasoning=true`、`supportsReasoningEffort=false`，没有 thinkingFormat。SDK 会话 `off` 时既不发送 `thinking`，也不发送 `reasoning_effort`。`request-before.json` 确认两者缺失。火山默认思考未关闭，输出预算还包含推理。
3. 火山官方文档说明 `max_tokens` 和 `max_completion_tokens` 控制回答和思考内容，Chat API 默认 128K，`reasoning_effort=none` 可关闭思考。来源为 https://console.volcengine.com/ark/region%3Acn-beijing/docs/deepseek-v4-1-flash 的“关键 API 参数”和“最大输出长度”段。本轮 fetch 已读取原文。该文档的升级 1017 说明涵盖 261017 和 260910。Coding endpoint 的实际关闭支持另外通过实测确认，不仅相信公开文档。
4. `upstream-probe.json` 记录同一 coding endpoint 两个非流式小请求。未传 thinking 时，上游 `completion_tokens=11`，其中 `reasoning_tokens=9`，thinkingChars=36。显式传 `thinking.type=disabled` 时，`completion_tokens=1`、`reasoning_tokens=0`、thinkingChars=0。两次共 54 token，正文和思维链未保存。证明上游支持关闭参数，且推理 token 计入 completion token。
5. 旧诊断合同允许多条长事实、候选、动作，正文还重复结构化内容。旧轮 9 个失败输出都达到 8192 token，但没有格式重试或可见降级，模型一旦生成不完整 JSON，整个报告就失败。新测试先在旧代码运行，3 项全部失败，报 `all specialists failed`。失败测试单独提交为 `87f5e1b`。

## 修复

生产模型目录设置 `maxTokens=16384`，增加 `compat.thinkingFormat=deepseek`。这个兼容开关让 pi-ai 在 off 时发送 `thinking:{type:disabled}`，不伪装成无推理能力模型。保持 `supportsReasoningEffort=false`，不用尚未在 coding endpoint 验证的 effort 参数。`request-after.json` 捕获实际 SDK 请求，新轮每个调用还保存脱敏 requestParameters。16384 小于官方 128K 能力，又为简洁诊断留出余量。本轮成功回答最大 2307 token，没有靠持续用尽大预算写完。

新轮 lab 使用 `results/2026-10-21-output-budget/pi-agent/models.json`。它与 `deploy/docker/models.json` 字节一致，避免生产和评测预算不一致。没有修改不在授权范围的旧 lab 模型目录。复跑必须使用下面的新 lab 目录，旧 start-runtime 仍指向旧目录，不会因本次提交自动改变。

提示词要求完整 JSON 目标不超过 6000 字符，observations 最多 3 项、候选最多 2 项、未知最多 3 条、动作最多 4 项。动作只写必要对象、前提、操作、成功判据和风险，不能为缩短丢审批、回滚。这里只调整生成目标，不收紧协议 schema，已有合法长报告继续可读，已有长报告保真测试仍通过。

专家和 coordinator 共用两次有界结构化生成。第一次 JSON、schema 或 length 结束失败，第二次明确要求更短 JSON，不回放坏 JSON。两次仍失败时，专家生成低置信旧字段 findings，coordinator 生成无 diagnosis 的旧字段报告。只提取完整 JSON 字符串字段，不修补半个动作或伪造结构化依据；没有完整旧字段时写服务、事件和人工核对步骤。正文明确标“诊断不完整”“修复尚未确定”。引用越界仍拒绝，不进入降级。没有额外第三次恢复调用。网络异常和执行超时仍按原有失败处理，不扩大本次范围。

适配器保存 stopReason、thinkingChars 计数和白名单请求参数，不保存思维链。重试用量进入总账。CLI 每次调用前检查剩余预算，不只在案例之间检查。原有 100 万 token 总上限保持。

## 修复前后

每列 token 均为 provider 回报 input+output，不含 cacheRead。不是账单金额。耗时为逐例模型链路毫秒，不是独立性能实验。

| 案例 | 修复前完整诊断 | 修复后完整诊断 | 前 token | 后 input/output | 后 token | 前耗时 ms | 后耗时 ms | 消息 bytes | 后内容检查 |
|---|---|---|---:|---|---:|---:|---:|---:|---|
| DataAsset 197 行 | 否 | 是 | 11431 | 8358/3363 | 11721 | 55175 | 18064 | 3049 | 全通过 |
| JVM 堆 OOM | 否 | 是 | 24061 | 21970/10355 | 32325 | 106071 | 62612 | 3304 | 缺止损 |
| CPU 配额短时压力 | 否 | 是 | 20973 | 17535/9800 | 27335 | 90333 | 52857 | 3285 | 全通过 |
| 标签组 502 | 否 | 是 | 9860 | 4616/2311 | 6927 | 46667 | 12414 | 2627 | 缺止损 |
| SOP 404 | 否 | 是 | 19643 | 4824/2473 | 7297 | 89090 | 14214 | 2874 | 缺止损 |
| health 503 | 否 | 是 | 9555 | 3781/2060 | 5841 | 51192 | 21458 | 2554 | 缺止损 |
| 栈溢出 | 是 | 是 | 27643 | 4699/3095 | 7794 | 120111 | 33765 | 3393 | 缺止损 |
| 合计 | 1/7 | 7/7 | 123166 | 65783/33457 | 99240 | 558639 | 215384 | 全部小于4000 | 2/7全通过 |

本轮 23 次调用，较旧轮 12 次多。原因包括真实补证后的专家重跑、OOM 的 schema 重试和栈溢出专家重试。没有重复执行整个案例。所有真实返回均未出现 length。22 次正常 stop，另一次栈溢出 container_host 返回 error 和空正文，后续短重试仍未通过 schema；JVM 专家成功，使最终完整报告正常生成。该 error 请求未有 provider usage，SDK 返回 0，因此本轮预算是已回报 token 总和，不能保证上游 error 绝对未计费。

所有实际请求都含 maxTokens=16384、thinking.type=disabled。全部 thinkingChars=0。没有保存思考内容。唯一上游小探针另计 54 token，合计已回报 99294 token，远低于 100 万。新轮完整报告无降级，降级及可见消息由 fake 模型回归测试覆盖，不能声称真实模型已走通降级。

## 内容质量仍不达标的证据

- OOM 无止损，验证步骤还把 `docker.stats` 称为“堆使用”。实际 stats 是容器总内存，不是 JVM 堆。它把 NanoCpus 错写为 2e8，原始 inspect 为 2e9。证据为 `jvm-heap-oom.json` 的 report 与 modelContext。没有修改 agent 或扩展本次修复。
- CPU 自动通过，但把 JIT/初始化或采样抖动提为首要候选，没有线程热点证据；把真实约1.9核区间与约0.09核区间都说成事后数据，低估对故障期的佐证。证据为 `cpu-quota-burst.json` 与 `messages.md`。保留原 oracle，不为通过率改评分。
- DataAsset 把 NanoCpus=2e9 写成 NanoCpus=2，混淆原始单位与核数。证据为 `dataasset-197.json` modelContext 与消息依据。
- 标签组、SOP、health、栈溢出没有止损类别。业务错误未证实持续影响时，保守只补证未必错误，但 OOM 和栈溢出至少应给条件化止损。自动失败原样保留。栈溢出这次源码检查到达消息，旧轮关键检查被裁的症状未复现，但不能据此声称渲染器已改好。

## 验证及复跑

```bash
pnpm --filter @pi-ops/pi-runtime exec tsx --test src/__tests__/output-budget.test.ts
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/pi-runtime typecheck
pnpm --filter @pi-ops/protocol test
pnpm --filter @pi-ops/protocol typecheck
```

新增 output-budget 回归共 5 项。覆盖截断后短重试成功、连续截断降级、coordinator 连续截断降级、length 即使可解析也不当完整输出、超长 schema 降级及合法输出保真。`message-chain.test.ts` 另验证降级正文由真实 agent 渲染器经 fake fetch 可见。runtime 78 通过、0 失败、1 个可选 SDK smoke 跳过，protocol 36 全过；类型检查通过。没有更改 protocol。

在仓库根目录复跑新配置，输出到新目录：

```bash
PI_CODING_AGENT_DIR="$PWD/apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent" pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/message-cli.ts --live --out artifacts/on-call-messages/output-budget-next
```

`messages.md` 保存全部 7 条消息原文；每例 JSON 保存完整诊断、实际调用、用量、结束原因与参数。`request-before.json`、`request-after.json` 为 SDK fake fetch 捕获。`upstream-probe.json` 为真实上游最小对照。`capture-request.ts` 可复跑离线请求捕获，`probe-budget.ts` 会产生最多两次真实调用。凭据从本机未跟踪 runtime-secrets.env 读取，不输出或写入仓库。

## 新坑 / 决定

- SDK 的 thinking=off 不足以关闭这个 OpenAI 兼容端点。已通过请求体缺字段和上游 reasoning_tokens=9/0 对照核实，使用已安装的 deepseek thinkingFormat，而不是改模型能力标记。
- 预算修复不等于诊断内容正确。7/7完整报告、2/7内容检查全过，以及 OOM/CPU 的单位与取证推断错误是本轮现场证据。
- 保持协议读取上限不变。只约束新生成长度，已有近2000字符建议继续保真，通过 diagnosis-actions 测试确认。
- 原 lab 配置没有自动升级。本次授权不含旧 artifacts 配置，故保存生产一致的新 lab 模型目录并在复跑命令显式指定，不能继续用旧路径宣称生效。

没有外发企微，没有触碰 agent 通知策略或 store，没有推送。没有验证新策略是否会补发旧字段降级报告，该策略由另一会话负责。
