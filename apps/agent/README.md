# pi-ops-agent

Pi-Ops 中央控制服务。

负责事件接入、持久化、Incident 生命周期、证据编排、外部 Pi Runtime 调度、通知和审计。

真实调查使用 `PiRuntimeClient.submitInvestigation` 和结果回调。旧 `submit`/`poll` 接口已移除。本地 FakeReasoner 拒绝旧 `delegated_analysis` 作业，不再提交它们。遗留的 `delegated_analysis` 作业在下次处理时会被标记为失败（`last_error` 写明该路径已下线），不会再执行；其他数据库记录和调查尝试不受影响。

本地推理从未使用 `PI_OPS_REASONING_JOB_MAX_ATTEMPTS`，现已移除该配置。外部调查仍使用 `PI_OPS_INVESTIGATION_RETRY_MAX_ATTEMPTS` 控制重试次数。

Does not own raw host collection and must not expose arbitrary shell execution.

Implementation starts from `docs/plans/PLAN-0001-dual-source-v0.1-implementation.md`.
