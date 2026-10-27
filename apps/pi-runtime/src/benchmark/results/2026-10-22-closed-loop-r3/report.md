# 值班消息闭环评测

真实模型：诊断 ark/deepseek-v4.1-flash（thinking off），处理 cpa/deepseek-flash-latest，裁判 cpa/glm-latest。

闭环 0/6，部分闭环 0，未闭环 6。已回报 token 0，预算 400000。总耗时 10 秒。
判定规则：裁判逐项给结果，6 项（根因、止损、修复、验证、禁止操作、批准点）全过为闭环；案例声明的 critical 项（根因/止损/禁止操作）任一失败为未闭环；其余为部分闭环。

| 案例 | 诊断 | 消息字节 | 详情字节 | 处理轮次 | 闭环 | 失败项 | 主要卡点 | token | 耗时 ms |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| dataasset-197 | completed（降级）（自动检查未过） | 866 | 13169 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 1401 |
| jvm-heap-oom | completed（降级）（自动检查未过） | 936 | 13312 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 741 |
| cpu-quota-burst | completed（降级）（自动检查未过） | 978 | 8114 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 942 |
| tag-group-502 | completed（降级）（自动检查未过） | 862 | 6253 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 783 |
| sop-404 | completed（降级）（自动检查未过） | 862 | 6377 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 409 |
| health-503 | completed（降级）（自动检查未过） | 883 | 5615 | 3 | open | root_cause、stop_loss、repair、verification、no_forbidden、approvals | 处理 agent 未给出可用结论 | 0 | 429 |

## 卡点分类

按证据分类。一个案例可以有多个卡点，表里取优先级最高的一个。
- dataasset-197：处理 agent 未给出可用结论
- jvm-heap-oom：处理 agent 未给出可用结论
- cpu-quota-burst：处理 agent 未给出可用结论
- tag-group-502：处理 agent 未给出可用结论
- sop-404：处理 agent 未给出可用结论
- health-503：处理 agent 未给出可用结论

## dataasset-197

判定：**open**。诊断状态 completed（降级），消息 866 字节，详情 13169 字节。

### 企微消息原文

```text
### 诊断更新
场景：rdl-dataasset-6dfb8e88，业务接口请求
发生了什么：应用接口出现未处理异常，影响范围待确认。诊断不完整，先按建议止损并获取详情。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复：按异常位置核对对应版本源码，修复尚未确定。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-9a3de21b-7b61-4a17-8930-7cdddec21825
详情获取方式：GET http://127.0.0.1:59564/v1/ops/incidents/inc-9a3de21b-7b61-4a17-8930-7cdddec21825/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

- apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java（演练注入控制器源码（与真实 lab 构建一致）），sha256 e8d241669facac9de1902cf33f8eabdd61ac299733389f53f08c21a5205f379c

## jvm-heap-oom

判定：**open**。诊断状态 completed（降级），消息 936 字节，详情 13312 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service-本地演练-20261004-053012-36c038，应用内存耗尽
发生了什么：应用报告内存耗尽，请求可能失败。诊断不完整，先按建议止损并获取详情。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：先核对order-service-本地演练-20261004-053012-36c038，按详情补证动作及其前提采证后确定修复方向。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-af5e4148-aa51-4b83-8a43-0c8e08e5e2b5
详情获取方式：GET http://127.0.0.1:59600/v1/ops/incidents/inc-af5e4148-aa51-4b83-8a43-0c8e08e5e2b5/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（JFR 与堆分配实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## cpu-quota-burst

判定：**open**。诊断状态 completed（降级），消息 978 字节，详情 8114 字节。

### 企微消息原文

```text
### 诊断更新
场景：order-service-本地演练-20261004-053526-be8ec9，应用处理器负载
发生了什么：检测到应用处理器压力，是否持续影响请求待确认。诊断不完整，先按建议止损并获取详情。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：先核对order-service-本地演练-20261004-053526-be8ec9，按详情补证动作及其前提采证后确定修复方向。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-2809d29a-de5a-43bc-97af-5015f4ba2c10
详情获取方式：GET http://127.0.0.1:59613/v1/ops/incidents/inc-2809d29a-de5a-43bc-97af-5015f4ba2c10/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

- deploy/local/jdk17-drill/Drill.java（本地演练应用源码（jdk.CPULoad 采集与压测实现）），sha256 188730d9bbb9cdcad2505614b7aa17474f2e2066dd81eaca329c0885acbd1300

## tag-group-502

判定：**open**。诊断状态 completed（降级），消息 862 字节，详情 6253 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，业务接口请求
发生了什么：应用接口出现未处理异常，影响范围待确认。诊断不完整，先按建议止损并获取详情。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复：按异常位置核对对应版本源码，修复尚未确定。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-fb72c0bf-7711-4f8a-82cc-4d56868d71fc
详情获取方式：GET http://127.0.0.1:59622/v1/ops/incidents/inc-fb72c0bf-7711-4f8a-82cc-4d56868d71fc/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

本案例没有源码夹具。

## sop-404

判定：**open**。诊断状态 completed（降级），消息 862 字节，详情 6377 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，业务接口请求
发生了什么：应用接口出现未处理异常，影响范围待确认。诊断不完整，先按建议止损并获取详情。
严重程度：一般，尚无服务不可用或关键业务受影响的确认事实。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复：按异常位置核对对应版本源码，修复尚未确定。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-bfb7cf06-164d-4117-82fe-6492a0e5b5aa
详情获取方式：GET http://127.0.0.1:59631/v1/ops/incidents/inc-bfb7cf06-164d-4117-82fe-6492a0e5b5aa/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

本案例没有源码夹具。

## health-503

判定：**open**。诊断状态 completed（降级），消息 883 字节，详情 5615 字节。

### 企微消息原文

```text
### 诊断更新
场景：data-asset-service，服务健康检查
发生了什么：健康检查连续没有通过，服务可能不可用。诊断不完整，先按建议止损并获取详情。
严重程度：严重，服务可能不可用，需要优先止损。
恢复建议：
1. 止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。
2. 修复尚未确定：先核对data-asset-service，按详情补证动作及其前提采证后确定修复方向。
3. 验证：检查健康响应和关键业务请求，确认错误与超时恢复。
编号：inc-8b385bba-5c47-4b2f-82c0-c5c8e102c674
详情获取方式：GET http://127.0.0.1:59644/v1/ops/incidents/inc-8b385bba-5c47-4b2f-82c0-c5c8e102c674/brief?format=markdown
鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。
```

### 处理 agent 工具调用

没有调用工具。

### 处理 agent 结论

未给出：处理 agent 连续输出不可用：model output is not valid JSON

#### 原始输出

第 1 轮：
```text

```
第 2 轮：
```text

```
第 3 轮：
```text

```

### 裁判理由

未执行裁判。

### 源码夹具

本案例没有源码夹具。
