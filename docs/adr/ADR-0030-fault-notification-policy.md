# ADR-0030：按故障影响决定通知

状态：产品方向已批准；实现与迁移细节 proposed，尚未实施。

用户选择方案一：预期拒绝、单次普通错误和短峰值不发故障告警；持续且影响不明的压力先收证分析；确认不可用、关键任务失败、JVM OOME 和 cgroup OOM 必须通知，不依赖模型成功。同一故障不重复首次告警，有正向恢复事实后，仅向已告警故障发送一次恢复。调查完成默认只记录。选择的取舍是减少无行动价值的消息，同时让确定性重大故障不受模型可用性限制。

这改变了 [ADR-0027](ADR-0027-durable-operational-notification-delivery.md) 的逐生命周期排程方向，不追改该 ADR 的历史。当前代码仍在 Incident 创建、每个 InvestigationSession 完成和恢复时排程通知。批准方向不表示新策略已经实现，也不表示旧验收失效或历史评分需要改写。

Pi-Ops 仍拥有决定与投递，Runtime 仅提供分析。沿用 ADR-0027 的持久化、确定性任务 ID、事务、状态 guard、有限重试与至少一次交付边界，以及 [ADR-0029](ADR-0029-reasoning-plane-consolidation.md) 的唯一外部推理平面。模型建议不是事实，COMPLETED 不是故障或恢复证据。Evidence floor、PINNED Proof、accepted Proof Sources 和治理 guards 均不改变。

[最小实现规格](../plans/PLAN-0003-fault-notification-policy.md) 的字段、故障关联和迁移方案仍是 proposed。尤其首次告警未确认交付就恢复的处理尚未决定。目标、阈值、预算和执行授权仍未绑定。此次允许独立补 DataAsset 与 Starter 的非预期请求异常事件源，不授权真实故障、诊断模型、外部消息或部署。
