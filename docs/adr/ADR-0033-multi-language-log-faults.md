# ADR-0033: 多语言日志故障

状态为 Accepted，日期为 2026-10-27。容器日志要能识别 Python 和 Node 的故障，并继续按 [ADR-0030](ADR-0030-fault-notification-policy.md) 决定是否通知。身份仍遵循 [ADR-0031](ADR-0031-log-derived-fault-identity.md)。协议里事件类型是字符串，这次不升版本。

## 一条记录一个事件

node-agent 在同一条 stdout 或 stderr 流里认领。JFR 载荷仍先整批收集，再抑制后面的原始重复，事件 id 算法不变。其余先认异常块，块头前一条非空 ERROR 归这个块，再认没被认领的独立 ERROR 行。一条日志记录只产出一个事件。输出栈统一写 `attributes.stackTrace`，不再写 `exceptionStackTrace`。

致命不伪装成 Java。`runtime.oom` 和 `runtime.stack_overflow` 用 `attributes.runtime` 标明 `python` 或 `node`。中心按这个字段校验各语言自己的栈，不要求 Java 类名，也不要求 `at (...)` 帧。`stackIncomplete: true` 仍做首次通知，摘要注明栈不完整。

## 去重模板和故障键

这两个东西分开。去重模板只在 node-agent 使用：数字、IP、UUID、十六进制和引号内字符串换成占位符，用完整结果，不截断。故障键写入 `attributes.module`。异常块用异常类名，Python 保留模块名。独立 ERROR 行在级别后的字段像 `pkg.module` 时，用 logger 名加去重模板，否则只用模板。纯数字进程号不进故障键。

中心指纹不读模板、消息、计数或容器名。`runtime.oom` 和 `runtime.stack_overflow` 把 `source` 归一为 `application`，维度只有节点、服务和类型。同一服务的多个副本在窗口内合成一个 Incident，和 ADR-0031 对 `jvm.oom` 的理由相同。

## Docker 时间

原始日志事件的 `time` 用 Docker 打在行首的纳秒时间，带时区。识别前去掉这个前缀，正文保留原缩进。JFR 事件仍用载荷自己的 `timestamp`。事件 id 只由节点、容器、类型、异常类或故障键、块头的 Docker 纳秒时间决定，不含栈文本和重试次数。

中心给模型的日志投影先去掉 Docker 时间前缀，再保留 Python `File ...` 帧和 Node `at` 帧。没有时区的应用时间仍按现有规则当作 UTC。

## 忽略规则和复发

忽略规则放在中心策略 `services.<服务>.expectedLogErrors`，每条是 `{ruleId, contains}`。匹配是区分大小写的固定文本包含，只看普通日志事件的 `message` 和 `exceptionMessage`，不用正则，不看栈。只作用于 `LOG_ERROR` 和 `UNHANDLED_EXCEPTION`。命中的事件照样入库，通知事实转成 `expected-rejection` 并带上 `ruleId`，不进入持续性样本。致命事实不受这条规则影响。字段缺失时没有忽略规则。字段格式错时，中心按现有规矩启动失败。

普通日志报错仍走「持续出现，再发需要人工确认」。只对 `attributes.logEpisode === true` 的事件应用复发规则。node-agent 只给 Python 和 Node 的普通异常和独立 ERROR 写这个标记。Java、JFR、健康和致命事件都不写。事件时间比候选 Incident 的 `last_seen` 晚超过 `logErrorRecurrenceGapMs` 时不并入，开新 Incident，重新走持续确认。默认 3600000 毫秒。其他聚合逻辑不动。

## 通知和调查

`runtime` 致命和 JVM 致命同级，首次通知不等模型。决定函数不拿 `recognizedJfrSemantic` 判断 Python 或 Node。影响键形如 `runtime:python:oom`，中文标签写语言和故障，不写「JVM 错误」。摘要把这两类标为严重。`runtime.oom` 的收证计划与 `jvm.oom` 相同，`runtime.stack_overflow` 与 `jvm.stack_overflow` 相同。调查选择 `application_business` 和 `container_host`，不选 JVM 专家。

ragflow 初始忽略规则是 `ragflow-doc-owner-v1`，包含 `you don't own the document`。每天 03:30 约 15 秒的 MySQL 断连短于等待期，只记录不通知。本期不做维护窗口。
