# 修复办法或诚实未知说明

## 结论

代码修复和本地测试完成，七例真实模型验收 blocked。诊断服务额度耗尽，当前没有一例有效的模型输出，不能据此评价提示词改进。

本轮尝试六例，全部是 stopReason=error、空文本、记录 token=0。评测装置生成降级报告，处理 agent 也没有有效回答，六例均为 open、messageHardPass=false。stack-overflow 未跑。真实修复办法、模型写的修复未知、渲染兜底三类有效样本计数均为 0；六份降级模板单列，不混入模型未知。

## 改动与取舍

`apps/pi-runtime/src/specialists.ts` 要求证据足以定位源码、配置或变更时必须输出 repair，写清修改位置、方向和验证办法。仅有异常栈行号不视为已确认源码缺陷。证据不足时，uncertainties 解释修复未定的原因，summary.recovery 有一条以“修复尚未确定”开头的具体补证步骤。保留禁止猜测配置值的规则。

`apps/agent/src/on-call-brief.ts` 是唯一兜底位置。消息与详情摘要共用它，旧诊断也能得到诚实说明，原始 diagnosis.actions 不变，不会凭空增加 repair，也不影响按 repair 判断有价值诊断更新的通知策略。无 repair 且摘要缺明确未知说明时，使用首个补证对象指向详情中的补证动作和前提；没有补证动作时，提示核对故障版本源码、当前配置与接口契约。最多三条，每条不超过100字符；已有三条时替换中间项，保留首项止损和末项验证。恢复通知保持原行为。没有诊断的首次通知不增加诊断结论。

初版把补证 operation 直接放进短消息，全量 agent 测试发现这会泄漏详细命令。最终只使用补证 target 和详情指引。证据为 verify-2.log 的失败与 final-0.log 的404项通过。

`apps/pi-runtime/src/__tests__/diagnosis-actions.test.ts` 用明确源码行输入，检查专家与汇总提示词都携带强制 repair 和未知分支约束。它不声称 mock 模型能证明真实模型遵从。

`apps/agent/src/__tests__/on-call-brief.test.ts` 检查证据不足消息的诚实说明、三条和100字符上限、不修改原诊断、保留模型已有说明、恢复通知、缺补证动作，以及不把详细操作带进摘要。

本目录保存失败先行日志、全量验证日志、六份失败尝试、汇总和提供方错误探针。run-live.ts 逐例使用剩余40万token预算调用原 closed-loop-cli.ts --live，并合并结果。probe-model.ts 只发最小请求来读取SDK错误，不读取或记录凭据。

没有改 evaluator.ts、closed-loop-cases.ts、HANDLER_SYSTEM 或裁判。没有修改验证技能，没有发企微，没有启动compose栈。

## sop-404 止损判定

现有提示词强制止损的范围是可能服务不可用的内存耗尽、调用栈溢出、健康失败。第18单 sop-404 的证据只有一次下游 POST 404 和未处理异常，没有服务不可用或持续业务失败证据；诊断明确写“请求量、错误率、用户报障均未知，业务影响未确认”。因此本例不属于现有强制止损规则，并非漏掉已确认必须执行的止损。

证据为 ../2026-10-22-closed-loop/sop-404.json 的 result.diagnosis.report，以及 specialists.ts 的止损规则。evaluator.ts 的 mitigationInDiagnosis 却无条件要求所有案例都有 mitigation，未使用服务不可用条件。这解释第19单离线重评中的 sop-404 失败。本任务不修改检查，也不为了让检查通过而给没有影响证据的单次404强加变更建议。若之后发现持续业务影响，再按证据及审批前提止损。

## 逐例对比

第18单闭环来自 ../2026-10-22-closed-loop/summary.json。第19单CPU/OOM闭环来自 ../2026-10-22-closed-loop-r2/summary.json，其余五例当时没有重跑。旧 messageHardPass 使用第19单离线重评，不使用旧标签版的原始值。

| 案例 | 第18单闭环 | 第19单闭环 | 第19单10-22批消息检查 | 本轮装置闭环 | 本轮 messageHardPass | 本轮修复类别 |
|---|---|---|---|---|---|---|
| dataasset-197 | closed | 未重跑 | false，缺修复或明确未知 | open，提供方失败 | false | 降级模板，排除 |
| jvm-heap-oom | closed | closed | false，缺修复或明确未知 | open，提供方失败 | false | 降级模板，排除 |
| cpu-quota-burst | open | closed | false，缺修复或明确未知 | open，提供方失败 | false | 降级模板，排除 |
| tag-group-502 | closed | 未重跑 | false，缺修复或明确未知 | open，提供方失败 | false | 降级模板，排除 |
| sop-404 | closed | 未重跑 | false，缺止损 | open，提供方失败 | false | 降级模板，排除 |
| health-503 | closed | 未重跑 | false，缺修复或明确未知 | open，提供方失败 | false | 降级模板，排除 |
| stack-overflow | closed | 未重跑 | true | 未跑 | 未知 | 未取得 |

六份模板的未知文字来自 coordinator 的降级逻辑，不是模型按新提示词写的，也不是本轮新增渲染兜底补的。有效样本为0，不能称闭环从6/7退化为0/7，更不能称修复建议覆盖率已经提高。

## 模型与额度阻塞

诊断保持 ark/deepseek-v4.1-flash，处理保持 cpa/deepseek-flash-latest，裁判保持 cpa/glm-latest，thinking均为off。单例CLI dry-run已确认配置，live日志也逐例记录配置。未换模型，未重判，未重跑到满意。

probe-model.json 保存最小请求的真实错误：

```text
429: {"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota. It will reset at 2026-10-22 13:57:43 +0800 CST. ..."}
```

2026-10-22 10:24:34 +0800 检查时，距重置约3小时33分，超过允许的一小时等待窗口，因此停止，不再等待到重置。本轮CLI记录消耗0 token，探针usage也是0。SDK错误返回没有计费token，不把它表述为提供方账单保证。

初版编排检查了完整结果的429等关键词，health-503结果中的正常文本误命中，才触发停止；它此前未识别空输出和 stopReason=error。最终编排改成检查结构化 stopReason 和处理状态，不再扫描案例正文。已保存的六次尝试没有覆盖或删除。后续续跑必须写新子目录，不能用本目录失败结果冒充成功结果。

pi-session.ts 当前丢掉SDK assistant.errorMessage，closed-loop-cli 因而只展示“model output is not valid JSON”，并将降级报告继续交给处理agent。该问题在本任务范围外，未修改适配器。探针直读SDK响应才确认429，不能把所有提供方的空输出自动等同429。

## 验证

失败测试提交为027708c。改前两份针对性测试都失败，改后通过。

```text
requires repair for a located source defect and an explicit unknown recovery step otherwise
The input did not match the regular expression /证据足以定位.*源码行.*必须.*repair/.

renders an honest bounded next step when evidence is insufficient without inventing a repair
The input did not match the regular expression /修复尚未确定/.
```

| 命令 | 本轮观测结果 | 证据 |
|---|---|---|
| pnpm --filter @pi-ops/pi-runtime exec tsx --test src/__tests__/diagnosis-actions.test.ts | 改前5过1失败，改后6过0失败 | red-runtime.log，终端及verify-0.log |
| pnpm --filter @pi-ops/agent exec tsx --test src/__tests__/on-call-brief.test.ts src/__tests__/plain-summary.test.ts | 最终7过0失败 | 终端输出及final-0.log对应测试 |
| pnpm --filter @pi-ops/pi-runtime test | 92过，0失败，1原有可选SDK smoke跳过 | verify-0.log |
| pnpm --filter @pi-ops/pi-runtime typecheck | 通过 | final-2.log |
| pnpm --filter @pi-ops/agent test | 初版403过1失败；最终404过0失败 | verify-2.log，final-0.log |
| pnpm --filter @pi-ops/agent typecheck | 通过 | final-1.log |
| pnpm --filter @pi-ops/pi-runtime exec tsx scripts/benchmark-runs/2026-10-22-closed-loop-r3/run-live.ts | 六次提供方失败后停止，非有效模型验收 | live-*.log，六份json，summary.json |
| pnpm --filter @pi-ops/pi-runtime exec tsx src/benchmark/results/2026-10-22-closed-loop-r3/probe-model.ts | 明确429 AccountQuotaExceeded | probe-model.json |
| .agents/skills/verify-pi-ops/scripts/drive.sh doctor | blocked，五个服务均absent，未起栈 | doctor.log |

closed-loop装置本来会运行真实本机HTTP agent和临时磁盘SQLite，但使用保存的事件证据与fake fetch捕获通知。它不是故障产生、采证或真实通知投递演练。本轮所有模型均失败，更不能把它作为生产链验证通过。compose故障链没有运行，需另一个资源窗口；真实模型七例还需额度重置。

## 新坑 / 决定

1. 提供方额度未恢复。证据为probe-model.json的429 AccountQuotaExceeded和13:57:43重置时间。决定停止，不切模型、不等待超过一小时窗口。
2. SDK适配器隐藏原始错误。证据为六份json中stopReason=error、空文本和0token，对照probe-model.json的429原文。决定只用探针定位，不越界修改pi-session.ts。
3. sop-404不是现有必须止损场景。证据为旧sop-404.json的单次404及影响未知，specialists.ts的强制止损范围，以及evaluator.ts无条件mitigationInDiagnosis。决定保留检查，报告口径差异。
4. 补证操作可能是详细命令。证据为verify-2.log的“修复尚未确定：详细命令”失败。决定短消息只引用补证对象和详情动作，不复制operation。
5. 真模型验收没有有效样本。证据为summary.json六例open、degraded=true、tokens=0。决定三类有效计数均为0，不把降级模板计为模型写的未知或真实修复。
