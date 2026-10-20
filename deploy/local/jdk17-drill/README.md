# Java17 local workload

一次性 Java17 demo（JDK stdlib），不是 DataAsset 或生产发送器。仅在本地限额容器使用故障控制端点。故障动作、预期根因放独立 ground truth，不送入 Runtime。

## 组件回归

```sh
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
  python3 deploy/local/jdk17-drill/check.py
```

真实 Java17 编译、loopback receiver、sender on/off、实际 CPULoad/custom JFR/heap OOME、健康503→200、退出0/17、低于阈值不生成压力事件；证据保留在 gitignored `.checks/<timestamp>/`。不调用 Docker、模型或企业微信，不是全链路验收。

## 配置与端点

- `SENDER_ENABLED=true|false`（默认true）；关闭发送器仍消费JFR、保存日志且不需token。
- `PI_OPS_ENDPOINT=http://pi-ops:8080`，sender启用时需环境中的`PI_OPS_INGEST_TOKEN`，不打印秘密。
- `SERVICE_NAME=order-service`、`NODE_ID=local-dev`、`CONTAINER_NAME=order-service-local`、`RUN_LABEL=local`。身份/一般字符串1..256字符；containerName必须匹配实际容器/allowlist。标签不透根因。
- `BIND_ADDRESS=0.0.0.0`、`PORT=8088`；宿主机手工运行必须loopback。
- `CPU_THRESHOLD=0.80`有限`(0,1]`，`CPU_SECONDS=10`范围1..30，`CPU_THREADS=min(4,availableProcessors)`范围1..4。
- Docker默认`-Xms32m -Xmx128m`；heap动作要求max heap≤256MiB，不能设ExitOnOutOfMemoryError/CrashOnOutOfMemoryError测可恢复OOM。

GET `/health` 返回200/503；其他端点均POST：`/fail`、`/ok`健康开关；`/cpu`有限CPU计算202、忙时409；`/order`真实请求抛IllegalStateException、返回500；`/heap`触碰/保留数组至实际VM OOME（15s截止，未耗尽则不发OOM），释放引用/应急内存并GC；`/exit`、`/exit-nonzero`返回202后退出0/17。业务异常、heap OOM不改变健康状态。未知404、方法不符405。退出钩子停止CPU、JFR、HTTP和sender。

## JFR 与 EventBatch

RecordingStream实际启用/消费`jdk.CPULoad`（每秒）、`jdk.JavaErrorThrow`、`com.example.OrderFailure`、`com.example.MemoryFailure`，保留大小16MiB/30秒。自定义事件只在实际异常catch后commit；只有流回调生成OpsEvent，端点不直接提交Event。

Temurin17实测heap OOME不总有builtin JavaErrorThrow（预分配异常路径），因此OOM传输来自释放内存后真实catch的custom JFR；保留任何实际builtin观察但不重复归一化。OOM JFR时间是释放后commit时间，不冒称VM抛出时刻。真实栈保留Drill来源，不能伪改。

producer=`{id:SERVICE_NAME+'-jfr',type:'application',version:'0.2.0'}`；每batch一event，schemaVersion1、UUID、time=RecordedEvent.startTime、source=jfr、node/service；公共attributes=`jfrEventName,jfrStartTime,jfrEndTime,containerName,runLabel`。CPULoad→`jvm.cpu_pressure/warning`，保留jvmUser/jvmSystem/machineTotal；MemoryFailure→`jvm.oom/critical`，OrderFailure→`business.error/error`，保留实际exceptionClass/exceptionMessage/stackTrace（约6KiB）和commit的jfrStackTrace，business另有operation=submitOrder。

CPU检测只看实际user+system≥threshold，不依赖控制开关；间隔10秒。低阈值可能使真实基线/启动压力生成事件；保留默认表现。日志`JFR`保存原始样本、`JFR_EVENT`保存实际batch。容量16非阻塞队列，异步sender连接3秒/请求5秒，重试0；失败/满队列明确日志，允许丢失、不保证停机flush。

产品目前jfr.signal只识别CPU语义、仅保留CPU指标/容器名，异常附加属性在原始batch/日志但不保证进入模型视图。HTTP接收成功不等于正确诊断。此组件不修产品映射。

## heap 与 cgroup 对照

仅在命名明确的一次性容器，CPU≤2且restart=no。可恢复heap：memory=512MiB、swap同额、Xmx128MiB；调用/heap后实际OOME、释放、health200，Docker未OOMKilled。

真实cgroup模式：memory=192MiB、swap同额、Xmx256MiB、sender=false，实际触碰页面分配由容器RSS限额先约束。必须取得Docker raw oom、inspect OOMKilled、ExitCode和限额；137单独不证明OOM。kill后无自定义JFR/健康保证。用/exit-nonzero对照。

默认Compose旧overlay仍使用阈值0.01，未传身份/发送器开关。新的opt-in `docker-compose.fault-drills.yml`与`fault-drills.py`负责明确参数、loopback端口、中性runid身份、串行真实矩阵。停止观察器后才能替换demo；结束停观察器/负载并恢复健康。证据保留，不删除旧目录。全链路结果见`docs/local-fault-drills.md`。
