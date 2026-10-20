# PLAN-0003：通知策略最小实现规格

状态：proposed。产品方向见 [ADR-0030](../adr/ADR-0030-fault-notification-policy.md)，不是完整实现合同已获批准。本波只改文档；中央仍运行旧策略。下列字段名和实现顺序供下一环节审查，不授权生产修改或部署。

## 当前调用与缺口

- `packages/protocol/src/index.ts` 已有 schemaVersion 1 的 `OpsEvent`、`EventBatch` 和开放 `attributes`。继续用 `business.error`，不新增 wire schema 或事件总线。
- `apps/agent/src/store.ts` 的 `createIncidentFromEventTransaction` 无条件排 `INCIDENT_OPEN`；`applyRecoveryTransaction` 无条件排 `INCIDENT_RECOVERED`。`findIncidentForEvent` 用 last_seen 聚合窗，不能保证长期同故障只有一个 Incident。
- `apps/agent/src/investigation-loop.ts` 的 `complete` 在保存报告与结果的事务中排 `INVESTIGATION_COMPLETED`。同 session callback 重放返回已有报告，不同 session 仍各排一条消息。
- `notification.ts` 的任务 ID 按 Incident 或 session 生成；`store.ts` 的唯一索引与 RUNNING 状态 guard 防止逻辑重复。`notification-worker.ts` 负责发送、有限重试和重启恢复，不负责模型判断。
- `packages/protocol/src/investigation-runtime.ts` 的报告只有 hypothesis、证据引用、confidence、recommendation，没有可信的告警许可字段。`apps/pi-runtime/src/coordinator.ts` 补证一次后综合报告，失败可以返回 failed。不能从 recommendation 文本或 confidence 阈值直接授权通知。

## 最小决定及依据

先在 agent 内定义一个 `AlertDecision` 值，复用 Incident ID 作为故障记录身份，不新建 Fault、AlertCase 或独立策略服务。字段为 `incidentId`、`policyVersion`、`evaluatedAt`、`action: record | analyze | alert | recover`、`reason`、`eventIds`、`evidenceIds`、`missingFacts`。分析关联用可选 `investigationSessionId`、`reasoningResultId`，恢复关联用可选 `initialNotificationId`。增加 `facts` 保存下述事实快照。拟在 incidents 增加可空 `alert_decision_json` 保存最新决定；Event、Evidence 和报告能还原输入，但不能代替历史决定记录。首次排程时须冻结其决定依据，拟在 notification_jobs 增加可空 `decision_json`，不进入外部 payload。是否需要保存每次未排程决定的历史留待实现评审，不先建通用审计平台。

事实快照最少标出故障对象、观测区间、信号类别、影响是否已确认，以及判定使用的配置来源。失败次数、总请求数、采样窗、触发条件、恢复条件分别允许 `unknown`。未知不是 0，也不是未发生。`event_count` 是去重事件记录数，不是失败请求数；采样、聚合或丢弃后不能由它反推失败率。单条事件不证明只失败了一次。缺少业务影响和阈值时，普通异常最多记录或分析，不能伪造一个触发次数或窗口。

事实只引用所属 Incident 的已接收 Event 和成功 Evidence，并核对对象与发生时间。模型输出仍放在现有 report/result 的分析字段，不能写入事实快照。确定性重大类别必须有实际依据，例如已绑定健康目标的失败转换及配置、已确认关键任务的失败结果、真实 OOME 类型、cgroup oom 事实。severity=critical、错误文本含 OOM 或 exitCode=137 单独都不够。

新增字段范围尽量限于内部决定、策略版本与事实依据。复用 NotificationJob 的 DELIVERED 和 deliveredAt 判断交付，不新增一个可能漂移的 `notified` 布尔值。复用现有 NotificationPayload；若未来首次告警携带分析，需要明确修改 `buildNotificationPayload` 当前只给 COMPLETED 附 analysis 的条件，保持 facts/analysis 分离，不悄悄改 wire version。本规格不要求该扩展。

## 判定表

| 可证明的条件 | 决定与消息 |
| --- | --- |
| 预期拒绝、已观测单次普通错误、已绑定规则下的短峰值 | record；首次 0，恢复 0。 |
| 持续模糊压力或普通异常，影响未知 | analyze；首次 0。模型或补证失败时保留 unknown，不当成正常或重大故障。 |
| 影响已由当前事实确认的持续普通异常 | alert；模型建议可解释事实，不独立授权。尚缺影响规则时保持 GAP。 |
| 已确认不可用、关键任务失败、JVM OOME、cgroup OOM | alert；先排确定性事实通知，不等待收证或模型成功。补充失败不撤销该决定。 |
| 同故障重复事件、同或不同 Investigation 完成 | 更新记录；首次总数不增加，COMPLETED 消息 0。 |
| 正向恢复且首次 DELIVERED | recover；关联首次 notificationId，恢复逻辑任务恰 1。 |
| 正向恢复但从未告警 | 记录恢复，不发恢复消息。 |
| 先恢复后迟到报告 | 保存合法报告，不重开故障、不补首次或 COMPLETED 消息。 |

“已通知”暂以内部确认 DELIVERED 为可观测下限，不表示人类可见或平台支持幂等。进程在发送后确认前崩溃仍可能物理重发，沿用原 notificationId 和原重试边界，不声称 exactly-once。

首次仍 PENDING/RUNNING 就恢复是未定产品边界。候选是记录恢复事实、保留首次任务，待首次 DELIVERED 后排一次恢复；最终 FAILED 则保留交付缺口，不发恢复。该候选未获批准，不可默认为生产行为。如果采用，迟到首次消息须表达已知恢复状态和故障发生时间，不能描述成当前仍在故障。这里只给候选，不改变现有重试、任务 payload 或旧队列。

## 故障身份与恢复

同一故障不重复叫人要求先解决 Incident 关联，不能只在 notifier 去重。拟对已确定同一故障对象、类别和因果 episode 且未恢复的事件复用活跃 Incident，不因聚合窗经过而重建。同一对象不等于同一故障；没有正向恢复信号时的长期关闭规则尚未确定，不能无限合并来掩盖缺口。恢复后再次失败是新故障。没有足够对象身份时不全局按错误码合并；不同操作同 code/module、跨源 OOM 与 die 的关联仍需来源事实，缺失时标 GAP。保留多候选恢复 fail closed。

`business.error` 当前没有恢复映射。B02 的恢复需同接口同操作成功和批准的恢复窗，不能把 health 200、无新 ERROR 或 COMPLETED 当作恢复。不在本波杜撰 `business.error_recovered` 或增加定时自动恢复。应用源先独立补异常事件，计数与正向恢复信号合同另行补齐后才实现 B02 全闭环。

## 路径归属与顺序

本波中央文档 owner 独占本文件、ADR-0030 与两份 testing 规格，不改生产、协议或默认测试。应用 owner 独占 supervisor 指定的独立 DataAsset 源码工作区中全局异常处理入口、`BusinessErrorRecorder` 及必要 Starter/JFR sender 文件和离线测试。具体源码路径以应用 owner 的读查报告为准；不得触碰 `/Users/hejiayuan/code/data-asset` 的 dirty 主工作区，不 checkout。

1. 应用 seam 复用 BusinessErrorRecorder → JFR → sender → EventBatch。只覆盖非预期请求异常，预期拒绝不发故障事件。固定 businessCode/module 的身份语义，异常类、有限脱敏栈和响应状态放既有 attributes；字段是否实际可携带由应用 owner 验证，不宣称现有 recorder 已支持。禁止请求头、请求体、SQL 参数和凭据进入事件。此 seam 可独立编译和离线验证，不等待中央实现。
2. 下一波中央 owner 在获准后独占 `apps/agent/src/notification.ts`、`store.ts`、`incident.ts`、`fingerprint.ts`、`investigation-loop.ts` 及专用离线验收。先实现内部决定与持久化，再把创建/更新/恢复/完成四个入口接入同一判定。去掉默认完成消息的排程，不删除历史任务类型或报告。
3. 同一中央 owner 接续 `notification-worker.ts` 中交付后的恢复联动，仅在上述竞态细节确定后实施。决定和排程保持事务原子性，既有任务唯一索引、RUNNING guard、attempts、maxAttempts、终态和重启重试不变。
4. `packages/protocol/**` 与 `apps/pi-runtime/src/coordinator.ts` 本计划不修改。需要新的模型建议字段时另提小合同，不能借机建通用规则 DSL、重写 coordinator、迁移整个 store 或放宽证据权限。

## 离线 literal 验收

未来使用独立空库、固定时钟、内存事件与 FakeNotifier。以下数值是断言输出，不是产品触发阈值；输入窗口与触发计数必须来自明确 fixture 配置，未绑定则 `BLOCKED`。不执行目标探测、故障注入、真实模型或外部通知。

| 案例 | 固定断言 |
| --- | --- |
| B01 成功正例与已分类预期拒绝对照，真实应用离线处理链 | sender 故障事件数 `0`，中央首次 `0`，恢复 `0`。手工 business.error 不能替代发送器证明。 |
| B02 非预期异常正例与成功对照 | 正例经 recorder/JFR/mapper 得到 `type=business.error`，有实际异常类与稳定 code/module；成功对照故障事件 `0`。只编译通过不等于链路通过。 |
| B02 普通单次且无重大事实 | `action=record`，首次 `0`，完成消息 `0`。缺次数时 `missingFacts` 包含计数缺口，不冒称单次。 |
| B02 持续但缺影响证据 | `action=analyze`，首次 `0`，影响 `unknown`；补证失败和模型不可达分别覆盖。 |
| B02 持续且按绑定规则确认影响 | 同故障 Incident `1`、首次逻辑任务 `1`；同事件重放与不同 session 完成后仍 `1`，完成消息 `0`。无恢复合同则恢复 `GAP`，不得伪造通过。 |
| S06 按 fixture 绑定规则确认不可用正例 | 模型 failed、补证 failed 时仍首次 `1`；成功交付后同目标正向恢复为 `RECOVERED`，恢复任务 `1`。 |
| S06 瞬态失败对照 | detector 故障事件 `0`、首次 `0`、恢复 `0`。不借 duration 默认值替目标审批。 |
| callback 与时序对照 | 同 session 重放不增加结果与消息；不同 session 可各留报告但完成消息 `0`；先恢复后报告首次增量 `0`。 |

成功发送的 FakeNotifier 用例分别断言 `['INCIDENT_OPEN','INCIDENT_RECOVERED']` 与 `[]`，不是只比较任务数。重大故障加入 OOME 与 cgroup oom 正例，以及普通 ERROR 与单独 137 对照。PENDING/RUNNING 恢复竞态只记录 proposed，未决前不得定义 PASS。既有 `first-batch-offline.check.ts` 是旧合同快照，保留原历史输出，不为了新策略改 golden 为当前结果。新验收必须单列预期与观测，且不加入默认测试或降低既有治理证明。

已落地的两份离线检查，命令在 `apps/agent` 下运行：

```text
./node_modules/.bin/tsx src/__tests__/notification-policy.check.ts
./node_modules/.bin/tsx src/__tests__/notification-stored-facts.check.ts
```

两个文件名都不是 `*.test.ts`。`apps/agent/package.json` 的 `test` 只加载 `src/**/*.test.ts`，所以默认 `pnpm test` 不会运行它们。不要把文件改成 `*.test.ts`，也不要加进默认 `test` 脚本。

两份检查自备数据，不需要准备数据库或环境变量。`notification-policy.check.ts` 用 `:memory:` SQLite 跑判定函数和旧 `INCIDENT_OPEN` 投递；`notification-stored-facts.check.ts` 在系统临时目录建 `facts.sqlite` 并从第二个连接改写行，结束前删目录。全部通过时 exit 0，任一断言不符时 exit 非 0。exit 0 只表示纯函数与事实层的合同快照匹配，不是上面任何一个场景的 `PASS`。

## 部署迁移边界

本波不部署、不操作旧数据库。未来先离线验证 additive 字段对旧库可读，旧行策略版本缺失表示 legacy，不回填新决定。不得回放、自动取消、删除、重排或改写旧任务。新策略只用于批准的切换边界之后的新故障；旧 Incident 的新事件如何归属也需在切换清单显式锁定，不能靠启动时间猜测。

外发启用前必须单独审批数据库、队列范围、目标与消息预算。旧队列不明确时不启动连接真实 notifier 的 worker，因为它当前会 reset RUNNING 并扫描 PENDING。离线验证用新库，不以清空旧库解决迁移。旧库投递与迁移方案、未确认首次交付时恢复的规则、场景 T/W/R、业务影响与关键任务认定仍未定。文档和离线结果均不构成真实接入 PASS。
