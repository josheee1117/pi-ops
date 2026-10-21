# PLAN-0003：通知策略实现与配置

状态：步骤 4 和 5 已实现。产品规则见 [ADR-0030](../adr/ADR-0030-fault-notification-policy.md)。本页描述中央事实转换和离线验证，不构成真实部署或企微交付验收。

## 事实与决定

`notification-stored-facts.ts` 从同一 Incident 的不可变 Event 和成功 Evidence 构建事实。它核对关联、节点、服务和时间。模型报告不能写入事实。事件数、日志行数不是请求失败次数，没有分母就不计算失败率。

| 事实 | 决定 |
| --- | --- |
| 真实 OutOfMemoryError。application 与 JFR 要有消息或栈，原始 Docker 日志必须有 Java 栈。 | 立即首次通知。 |
| 真实 StackOverflowError，有 Java 栈。 | 立即首次通知。 |
| Docker oom action、oomKilled=true，或当前同对象 inspect 的 OOMKilled=true 且 FinishedAt 在故障窗口内。 | 立即首次通知。单独退出码 137 不通知。 |
| health.failure 与中央规则的 ruleId、版本、节点、服务、目标、URL、method、container、连续样本数及间隔匹配。 | 立即首次通知。缺绑定显式记录 health-binding。 |
| 非预期业务错误命中该服务的关键操作配置。 | 立即首次通知。4xx 拒绝不授权。 |
| 普通错误或 CPU、GC、慢 SQL 等独立观测，在服务等待期内持续且间隔不超过上限。 | 先 analyze，到期仍持续发一次"需要人工确认"。 |
| host 内存或磁盘迟滞已确认压力，尚无同对象恢复。 | 先 analyze，按服务等待期升级。它们是状态转换事件，不要求重复 failure。 |
| 孤立普通错误、已停止的短暂错误、预期拒绝、单独 exit 137。 | 不排通知。 |

不存在的 Incident 和非法时间抛明确错误。未支持来源、非法事件和缺操作身份保留来源 ID 与 gap。`EventStore.evaluateNotification()` 将失败保存为 action=error。运维接口 `GET /v1/ops/incidents/:id` 的 `notificationDecision` 暴露决定和缺口。legacy 返回 policyVersion=legacy，不伪装成无需通知。

`notification-decision.ts` 计算首次、一次有价值更新和恢复。`store.ts` 在事务内调用它。新证据直接触发重评。完成与失败、事件追加、期限轮询、恢复和首次 DELIVERED 都调用同一入口。调查 reconciler 跳过 record 且无需补绑定分析的故障，沿用现有 generation、backoff 和重试上限。

首次任务、补充任务、恢复任务各保留一个逻辑身份。新策略补充任务另有每 Incident 唯一索引。新修法比较结构化 repair 的 target、preconditions、operation、expectedResult、risk 和 requiresApproval，不比较 confidence 或引用顺序。修法必须引用当前成功证据。新影响只比较绑定事实类别，不从模型措辞反推。修法和新影响共用一次补发名额。

## 配置文件

Agent 读取 `PI_OPS_NOTIFICATION_POLICY_PATH` 指定的 UTF-8 JSON 文件。未设置时用 `apps/agent/src/notification-config.ts` 的默认值。指定文件替换整个默认配置，不合并。改完重启 agent。容器部署需将文件只读挂载到对应路径，再设置该环境变量。

以下是独立配置示例。orders 的 /login 是示例，不是已确认的生产默认路由。

```json
{
  "defaultUnknownImpactWaitMs": 300000,
  "defaultObservationMaxGapMs": 120000,
  "services": {
    "orders": {
      "unknownImpactWaitMs": 180000,
      "observationMaxGapMs": 60000,
      "criticalOperations": [
        { "ruleId": "orders-login-v1", "operation": "POST /login", "workflow": "登录", "owner": "orders 值班人" },
        { "ruleId": "orders-submit-v1", "path": "/orders/submit", "workflow": "下单" }
      ]
    }
  },
  "healthRules": [
    {
      "ruleId": "orders-health-v1", "ruleVersion": 1,
      "nodeId": "node-1", "service": "orders", "target": "orders",
      "url": "http://orders/health", "method": "GET", "container": "orders",
      "failureSamples": 2, "intervalMs": 10000
    }
  ]
}
```

每条关键操作必须只填 path 或 operation 之一。path 忽略 HTTP 方法，operation 精确包含方法或非 HTTP 操作名。支持单段 `{name}` 路由模板，不支持前缀通配。精确路径先于模板匹配。只把配置模板放进通知事实和新指纹，授权 code 与 query 值不作为关键操作身份。ruleId 改名不改变操作身份。配置增删后，中央用已保存事件按当前配置匹配活跃故障，不重复创建首次通知。

node-agent 的 `PI_OPS_HEALTH_TARGETS` 对应目标要配置相同的 ruleId 和 ruleVersion。中央 failureSamples 等于 `PI_OPS_HEALTH_FAILURE_DURATION`，这是连续失败样本数，不是秒。intervalMs 等于目标实际间隔。改这些字段需同步中央规则。旧 node-agent 配置仍能解析，但没有绑定就不授权重大通知。

## 默认值的依据

所有服务未配置等待期时使用 300000 ms，最大观测间隔使用 120000 ms。这是可改的运维默认值，不是已验证的业务 SLA，也不复用聚合窗。服务可分别覆盖。

| 服务 | 默认关键操作 | 仓内依据 |
| --- | --- | --- |
| dataasset、data-asset、data-asset-service | GET /auth/authClientInfo、GET /auth/{code}、GET /oauth/wework/code、GET /oauth/wework/code/{corp}。 | `artifacts/real-dataasset-lab/app/build/lib/data-asset-web-0.0.1-SNAPSHOT.jar` 的 AuthController 与 WeworkOauthController Spring 注解。用 `javap -v -p -classpath <jar> <class>` 核对。 |
| order-service、dataasset-jdk17-local-本地演练 | submitOrder，所属流程为下单演练。 | `deploy/local/jdk17-drill/Drill.java` 与该目录 README。不是生产核心任务清单。 |

默认健康绑定只有 local-dev 节点的 pi-ops-drill，URL 为 `http://pi-ops-drill:8088/health`，容器为 pi-ops-drill，ruleId 为 local-drill-health-v1，版本 1，连续样本数 1，间隔 2000 ms。依据为 `deploy/local/compose.env`，本轮同步了 node-agent 的规则字段。其他健康目标必须显式配置，不能拿本地规则冒充 DataAsset 线上绑定。

需要用户补齐实际生产 service 名、各服务等待期、核心业务流程的核心接口、负责人、生产节点及健康目标。DataAsset 四条路由存在的证据不证明每个部署都使用这些 service 名。未知的服务不会自动套用前缀规则。仓内没有其他生产服务的完整关键接口清单，没有编造默认值。

## 迁移与交付

新增 notification_decisions 表保存最新决定。incidents 新增 notification_policy_version 与 fingerprint_version，旧行默认 legacy 和版本 1。notification_jobs 新增 policy_version 和冻结 decision_json，旧行默认 legacy。没有回填、删除或重排旧任务。新故障标记策略版本 1、指纹版本 2。既有历史指纹修复逻辑继续按各行指纹版本运行，不把旧队列迁成新策略。版本 2 的业务故障保留保存时的指纹，不因操作配置变化重写。

新策略使用对象、操作和类别复用未恢复故障，不受短期聚合窗限制。缺操作身份时只在原聚合窗内关联。没有业务成功生产合同，不把 health 200、COMPLETED 或无新日志当作业务恢复。业务类故障长期关闭仍由运维管理，不新增猜测性自动恢复。

首次未发送即恢复会更新新任务的待发送快照，使用"曾发生、现已恢复"，不另排恢复。RUNNING 时恢复且发送成功，则首次交付后补恢复。发送失败回到 PENDING 或重启重置时再次判断恢复，首次重试改成恢复摘要，诊断重试终止。首次最终 FAILED 不发孤立恢复。旧任务不改写。恢复后尚未发送的诊断更新终止为 FAILED，last_error 说明 suppressed，不重新花费投递预算。

所有网络发送都在数据库事务之外。外部交付至少一次，不能声称 exactly-once。未配置 webhook 时 worker 仍运行决定轮询，但不发送或标记 DELIVERED。

## 验证入口

新增默认测试经真实 `scanContainerLog`、`dockerEventToOpsEvent`、`createHealthDetector` 转换，通过进程内 `/v1/events` 写入 SQLite 后检查事实、决定、任务和 fake fetch 消息。它们不是启动网络服务的 E2E，也不证明外部 DataAsset starter 的真实接入。

```sh
pnpm --filter @pi-ops/agent test
pnpm --filter @pi-ops/node-agent test
pnpm --filter @pi-ops/pi-runtime test
pnpm --filter @pi-ops/protocol test
pnpm typecheck
```

`notification-coverage.test.ts`、`notification-coverage-lifecycle.test.ts`、`notification-policy-config.test.ts` 和 `notification-migration.test.ts` 覆盖关键类别、反例、持续等待、重启、重复、跨窗口、报告价值、恢复竞态与 legacy。原 `notification.test.ts` 的投递 guard、重试和重启检查改用已绑定健康故障，不再靠无条件 slow SQL 排程。

`notification-policy.check.ts` 与 `notification-stored-facts.check.ts` 已按当前合同更新。它们仍不在默认 `*.test.ts` 测试中，需要在 `apps/agent` 下单独运行：

```sh
./node_modules/.bin/tsx src/__tests__/notification-policy.check.ts
./node_modules/.bin/tsx src/__tests__/notification-stored-facts.check.ts
```

策略检查覆盖 ordinary 的 analyze、计数未知、重大事实优先级、缺绑定和纯函数不修改数据库。存储事实检查经进程内 `/v1/events` 写入 SQLite，覆盖来源、关联、对象、时间、畸形属性的显式 gap、持续观测期限、缺 Incident 和非法时间抛错，以及孤立 slow SQL 不排无条件 OPEN。空观测请求仍与缺事实区分。critical-task 的 bound 输入仅检查纯函数合同，不证明任务执行器接入。

两个检查自备数据，不需要数据库或环境变量。存储事实检查在系统临时目录创建 SQLite，用第二个连接模拟畸形存储数据，结束后删除目录。全部通过时 exit 0，任一断言失败时 exit 非 0。未删除原有用例。重复的基础场景保留为检查入口的回归，生产转换器与生命周期的完整覆盖仍由 `notification-coverage*.test.ts` 提供。

## 未完成的生产者合同

关键批任务最终失败仍没有本仓可用的任务执行器生产链。不能用手写 bound critical-task fixture 声称接入完成。本轮核心接口由实际日志 JFR 转换链覆盖。生产业务成功与重试耗尽信号、完整关键任务清单需对应应用 owner 补齐。真正的非 OOM 意外容器退出还缺预期运行状态和维护绑定，单独 die 不当成 OOM 或已确认业务不可用。

真实模型、隔离故障演练和企微外发需要另行授权。旧库队列、目标和消息预算未确认前，不启动连接真实 notifier 的 worker。
