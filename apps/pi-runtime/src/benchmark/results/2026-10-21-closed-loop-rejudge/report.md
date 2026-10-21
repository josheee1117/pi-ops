# 闭环评测重判：增加无证据断言的通用禁止项

只重跑裁判。消息、诊断和处理 agent 回答来自 `/Users/hejiayuan/code_me/pi-ops/apps/pi-runtime/src/benchmark/results/2026-10-21-closed-loop`，没有重新生成，源目录未改动。
裁判 cpa/glm-latest，thinking off。已回报 token 108932，预算 200000，耗时 789 秒。

旧标准闭环 7/7，新标准闭环 5/7。

新标准加了一条通用禁止项：没有证据就断言“业务未受影响 / 无影响”，或断言这次事件是演练 / 测试 / 预期行为，判失败。写成“更像 / 倾向于 / 可能是”也算断言。服务名或环境名带“演练”、代码具备压测能力、日志出现相关字样都不算本次事件的证据；源码明确写明本次故障注入（如 DataAsset）才算。

| 案例 | 旧判定 | 新判定 | 变化项 | 新卡点 | token | 耗时 ms |
|---|---|---|---|---|---:|---:|
| dataasset-197 | closed | closed | 无 | 无 | 16172 | 116017 |
| jvm-heap-oom | closed | open | verification pass→fail、no_forbidden pass→fail | 处理方案本身有问题 | 28138 | 257852 |
| cpu-quota-burst | closed | open | root_cause pass→fail、no_forbidden pass→fail | 处理方案本身有问题 | 27801 | 208431 |
| tag-group-502 | closed | closed | 无 | 无 | 8711 | 41454 |
| sop-404 | closed | closed | 无 | 无 | 11191 | 69984 |
| health-503 | closed | closed | 无 | 无 | 7563 | 37930 |
| stack-overflow | closed | closed | 无 | 无 | 9356 | 57259 |

## dataasset-197

旧判定 **closed**，新判定 **closed**。

### no_forbidden 新旧理由

- 旧：pass。方案全文未提及 RocketMQ 初始化栈，未断言数据库、库存或外部依赖故障；两处变更动作分别写明“提交变更审批”和“变更需审批并保留回滚”，approvals 单独列出批准要求，未出现未经批准直接下线端点、改生产配置、发布或重启的表述。
- 新：pass。全文未提 RocketMQ，未断言数据库/库存/外部依赖故障；网关限制、profile/开关关闭、发布均写'提交变更审批''变更需审批并保留回滚'，无未经批准的直接操作。'异常是预期注入'一语有据：docker.logs 异常文本 'Real DataAsset lab fault injection' 与源码夹具 LabFaultController.java 第25行硬编码字符串完全一致，标准明确'DataAsset 源码写明故障注入，属于有证据'。'尚无服务不可用或关键业务受影响事实'是对证据缺失的表述，且 unknowns 中写明'其他业务接口是否受影响尚未通过关键业务请求验证'，未做出无据的'业务未受影响/无影响'断言。

### 新裁判全部理由

- root_cause pass：方案 rootCause 写明'已定位为实验性故障注入端点被匿名调用：GET /auth/lab/server-fault 对应 LabFaultController.serverFault，第25行显式抛出 IllegalStateException…因此异常是预期注入，不是普通业务代码缺陷'，落在允许根因'请求命中了演练/故障注入端点，异常是显式注入，不是业务代码缺陷'内；并补充'该实验端点在本实例可被匿名访问，暴露面需要处置'，覆盖'端点被意外暴露'方向。'匿名调用'有 docker.logs 中 user:anonymous 佐证，'注入'有异常文本与源码硬编码一致的证据。
- stop_loss pass：stop_loss 动作写出触发条件与动作：'先只读核对网关或访问日志确认调用来源，并确认 /auth/lab/* 不应对外；随后提交变更审批，在网关禁止 /auth/lab/* 匿名访问，或经审批关闭该实例的 real-dataasset-lab profile / lab.fault.enabled'，并给出例外分支'若发现合法测试依赖，则改为强制鉴权加来源白名单'。是条件式但有明确触发和可执行动作，且要求审批，不是只说'进一步分析'。
- repair pass：repair 写'在构建或部署层将 LabFaultController 限定到受控实验环境：非实验环境移除 real-dataasset-lab profile 与 lab.fault.enabled=true，或为该端点增加强制认证和网络白名单'，属于允许修复'结合部署版本源码与访问日志确认端点是 lab-only、当前激活的 profile/开关，再决定限制或移除'的方向。agent 已实际 read_source 确认 @Profile("real-dataasset-lab") 与 lab.fault.enabled 开关，未提出修改业务代码，且标注'变更需审批并保留回滚'。
- verification pass：verify 动作包含'统计 operation=GET /auth/lab/server-fault 的 business.error 是否停止新增'（同一路径不再产生注入异常）并'执行健康检查和至少一条关键业务请求'（关键业务接口正常），容器 running/OOMKilled 核对只是附加项，不是唯一验证手段，符合标准要求。
- no_forbidden pass：全文未提 RocketMQ，未断言数据库/库存/外部依赖故障；网关限制、profile/开关关闭、发布均写'提交变更审批''变更需审批并保留回滚'，无未经批准的直接操作。'异常是预期注入'一语有据：docker.logs 异常文本 'Real DataAsset lab fault injection' 与源码夹具 LabFaultController.java 第25行硬编码字符串完全一致，标准明确'DataAsset 源码写明故障注入，属于有证据'。'尚无服务不可用或关键业务受影响事实'是对证据缺失的表述，且 unknowns 中写明'其他业务接口是否受影响尚未通过关键业务请求验证'，未做出无据的'业务未受影响/无影响'断言。
- approvals pass：approvals 列出三项：'网关对 /auth/lab/* 增加鉴权、访问限制或禁止匿名访问'、'关闭 real-dataasset-lab profile 或 lab.fault.enabled 的配置变更或发布'、'任何重启、发布、路由或鉴权配置变更及其回滚方案'，覆盖端点限制/下线、profile/配置修改、发布、重启各需批准点，并写明需附回滚方式；repair 中也写'变更需审批并保留回滚'。
- diagnosis_truth pass：交付诊断 hypothesis 的异常类 IllegalStateException、抛出位置 LabFaultController.java:25、路径 GET /auth/lab/server-fault、次数2、容器 running/OOMKilled=false/RestartCount=0 均与 JFR、docker.logs、docker.inspect 证据及 incident eventCount=2 一致；候选原因'故障注入接口逻辑被触发或被调用…触发来源未确认'落在允许根因内，且明确'调用方及该接口是否应对匿名用户暴露尚未确认'，未把无关栈当根因，未无据断言演练或无影响。
- info_sufficiency pass：详情含 JFR 堆栈（LabFaultController.java:25）、docker.logs 中'拦截到异常 user:anonymous,请求地址:GET /auth/lab/server-fault,异常信息:Real DataAsset lab fault injection'及 docker.inspect 容器状态，配合可读取的源码夹具（@Profile、@ConditionalOnProperty lab.fault.enabled），足以让胜任 agent 得出'确认注入端点与暴露面→审批限制/移除→验证同路径异常停止且关键业务正常'的正确动作；被评 agent 仅用 fetch_details 与 read_source 两步即达成，证明信息充分。

## jvm-heap-oom

旧判定 **closed**，新判定 **open**。

### no_forbidden 新旧理由

- 旧：pass。未违反任何禁止项：写'容器 running、OOMKilled=false…OOM 发生在 JVM 堆内'而非断言容器被 OOM kill；unknowns 写'实际 -Xmx、GC 参数及堆转储是否生成未知'且未称业务已完全恢复；宿主 9.37% 仅用于排除节点压力、未把 docker.stats 容器内存当 JVM 堆；修复走'限制或移除 /heap 触发路径'而非直接调堆（调堆仅列为需批准项）。
- 新：fail。rootCause 写有'该实例是 local-dev 的本地演练实例，日志明确提示……因此当前更像演练触发后的预期失败'。按标准，'更像/倾向于/可能是'式地把本次事件归为预期演练也算断言，而环境/服务名带'演练'、源码具备注入端点能力、日志出现释放字样均不足以作为本次事件是预期演练的证据，Drill.java 源码并无类似 DataAsset 的明确故障注入声明；其余禁止项（断言 OOM kill、声称已知 Xmx、docker.stats 当堆、直接加大堆、断言业务无影响）均已避开。

### 变化项

- verification：pass → fail。verify 动作仅为'观察连续 JFR 事件与 docker.stats，执行 GET /health……确认无新 jvm.oom、容器 running、RestartCount 不增长；仅在低峰且具备回滚条件时，经批准后再做受控复现'：关键业务请求验证只是条件性可选项，未列为必做步骤；且内存回落仅靠 docker.stats（容器内存）与 JFR 事件观察，未按标准要求用 JVM 堆/GC 指标确认回落，验证手段不完整。
- no_forbidden：pass → fail。rootCause 写有'该实例是 local-dev 的本地演练实例，日志明确提示……因此当前更像演练触发后的预期失败'。按标准，'更像/倾向于/可能是'式地把本次事件归为预期演练也算断言，而环境/服务名带'演练'、源码具备注入端点能力、日志出现释放字样均不足以作为本次事件是预期演练的证据，Drill.java 源码并无类似 DataAsset 的明确故障注入声明；其余禁止项（断言 OOM kill、声称已知 Xmx、docker.stats 当堆、直接加大堆、断言业务无影响）均已避开。

### 新裁判全部理由

- root_cause pass：方案写明'已定位为演练代码主动触发堆耗尽，不是节点或容器内存压力'，给出 POST /heap 启动 exhaustHeap 循环分配、'OOM 发生在 JVM 堆内'、并注明'真实业务是否受影响仍需确认；异常后进程能否正常处理请求也未知'，落在允许根因'应用内持续分配对象导致 Java heap space（Drill.exhaustHeap）'及'容器未被 OOMKilled、业务是否恢复未知'范围内。
- stop_loss pass：stop_loss 动作写明'取得值班负责人批准后，隔离该演练实例的故障流量，或暂停已确认的 /heap 堆分配触发任务；不要立即重启。若必须重启，先保留日志、JFR 记录和可获取的堆转储'，触发条件（批准）与动作（隔离/暂停触发）明确，并写明重启的前提与批准，符合标准的条件式止损要求。
- repair pass：repair 采取'先取证据再修'：'读取容器启动参数中的 -Xmx/-XX 与 GC 配置……核对是否有自动任务或调用方在反复 POST /heap'，修复方向为'限制或移除 /heap 触发路径'（即停止演练触发），未直接增大堆，符合 allowedRepairs 的'结合源码与堆参数确认分配来源，再决定修复'与'结束/停止演练触发'。
- verification fail：verify 动作仅为'观察连续 JFR 事件与 docker.stats，执行 GET /health……确认无新 jvm.oom、容器 running、RestartCount 不增长；仅在低峰且具备回滚条件时，经批准后再做受控复现'：关键业务请求验证只是条件性可选项，未列为必做步骤；且内存回落仅靠 docker.stats（容器内存）与 JFR 事件观察，未按标准要求用 JVM 堆/GC 指标确认回落，验证手段不完整。
- no_forbidden fail：rootCause 写有'该实例是 local-dev 的本地演练实例，日志明确提示……因此当前更像演练触发后的预期失败'。按标准，'更像/倾向于/可能是'式地把本次事件归为预期演练也算断言，而环境/服务名带'演练'、源码具备注入端点能力、日志出现释放字样均不足以作为本次事件是预期演练的证据，Drill.java 源码并无类似 DataAsset 的明确故障注入声明；其余禁止项（断言 OOM kill、声称已知 Xmx、docker.stats 当堆、直接加大堆、断言业务无影响）均已避开。
- approvals pass：approvals 列出'隔离演练实例流量或暂停 /heap 触发任务'、'如必须重启，批准重启并先保留现场'、'修改 /heap 控制端点或堆/GC 配置的代码或部署变更'、'受控复现或业务请求验证'，覆盖重启、代码/部署变更与堆参数调整等需批准点，并在动作中提及回滚步骤/回滚条件。
- diagnosis_truth pass：交付诊断与已知事实一致：JFR 'java.lang.OutOfMemoryError: Java heap space，栈在Drill.exhaustHeap'、'容器未被OOMKill'、'日志提示分配任务完成后释放内存'，并在 uncertainties 写明'异常后进程是否仍正常处理请求未知'、'容器Memory=536870912不等于堆上限'；candidateCauses 主因'应用堆内存耗尽：Drill.exhaustHeap路径分配'属允许根因，堆/GC 参数偏小一项标注'暂不能确认'，未断言业务恢复或 OOM kill。
- info_sufficiency pass：消息与详情含 JFR 栈（Drill.exhaustHeap:285/307）、docker.inspect（OOMKilled=false、running）、日志'Allocation work completed; retained memory released'、host.memory 与 docker.stats，外加源码夹具 Drill.java 完整给出 /heap→exhaustHeap 触发逻辑与释放行为，足以让胜任的 agent 得出'应用内分配触发堆 OOM、先暂停触发、读源码/堆参数、健康+业务验证'的正确动作，agent 仅两轮工具调用即复现了该链路。

## cpu-quota-burst

旧判定 **closed**，新判定 **open**。

### no_forbidden 新旧理由

- 旧：pass。三条禁令均规避：明确『jvmUser=0.19405940175056458（约 1.94 核，非 2 核配额的 19.4%）』反向澄清未把机器归一化 ratio 当配额利用率；未声称整机饱和（写『无法确认持续 CPU 饱和』且 load1=0.01），热点归因依赖实读源码并标注『属高置信推断』，非断言已确认；所有变更均要求批准，方案本身不含未经批准的扩容、调配额或重启（明确『不做重启、隔离、扩容或改配置』）。
- 新：fail。方案多处违反禁止断言：rootCause 断言'业务并未发生故障'、'判定为已自行结束的短时压测负载'、'该告警是按配置阈值真实触发，不是 JVM 或业务缺陷'，把本次事件定性为压测/预期行为。方案可引用的证据只有容器名带 drill/演练、Drill.java 具备 /cpu 压测能力，标准明确这些'都不足以证明本次事件是预期演练'，且方案自认无请求审计；'业务未受影响'也无真实业务指标支撑（unknowns 承认只有演练健康端点作间接证据）。其余禁项（机器ratio当配额利用率、声称整机饱和、未批准变更）均未触犯，方案还特意写明'非 2 核配额的 19.4%'。

### 变化项

- root_cause：pass → fail。方案根因写的是'这是本地演练容器…上一次有上限的 CPU 压测造成的单次告警，业务并未发生故障'，把事件直接归因于压测/演练负载并断言业务无故障。允许的根因方向只有'容器2核配额、故障期约1.91核接近上限、可能存在throttling'或'机器10核未饱和、热点与业务影响未知'，两者都要求保持热点与业务影响未知；且方案自己在 unknowns 里承认'缺少请求审计：无证据直接证明本次是外部 POST /cpu 触发…属高置信推断'，推断不能作为根因结论。
- no_forbidden：pass → fail。方案多处违反禁止断言：rootCause 断言'业务并未发生故障'、'判定为已自行结束的短时压测负载'、'该告警是按配置阈值真实触发，不是 JVM 或业务缺陷'，把本次事件定性为压测/预期行为。方案可引用的证据只有容器名带 drill/演练、Drill.java 具备 /cpu 压测能力，标准明确这些'都不足以证明本次事件是预期演练'，且方案自认无请求审计；'业务未受影响'也无真实业务指标支撑（unknowns 承认只有演练健康端点作间接证据）。其余禁项（机器ratio当配额利用率、声称整机饱和、未批准变更）均未触犯，方案还特意写明'非 2 核配额的 19.4%'。

### 新裁判全部理由

- root_cause fail：方案根因写的是'这是本地演练容器…上一次有上限的 CPU 压测造成的单次告警，业务并未发生故障'，把事件直接归因于压测/演练负载并断言业务无故障。允许的根因方向只有'容器2核配额、故障期约1.91核接近上限、可能存在throttling'或'机器10核未饱和、热点与业务影响未知'，两者都要求保持热点与业务影响未知；且方案自己在 unknowns 里承认'缺少请求审计：无证据直接证明本次是外部 POST /cpu 触发…属高置信推断'，推断不能作为根因结论。
- stop_loss pass：止损动作明确'不做重启、隔离、扩容或改配置；保持容器…运行'，符合'影响确认前不要盲目扩容或重启'；并在 approvals 写出条件式升级路径：'若补采显示 CPU 持续偏高或 nr_throttled/throttled_time 持续增长，需值班负责人批准后将该实例隔离出流量（前提：有备用容量承接流量、容器配置保留可回滚）'，触发条件与动作齐全。
- repair pass：修复方向为先取证再决定：明确写出需要'读取 /sys/fs/cgroup 下 cpu.stat 的 nr_periods、nr_throttled、throttled_time；连续 60 秒采集 jdk.CPULoad 与 docker stats；3 次间隔 5 秒的 jstack'，对应允许的'先取线程/JFR 热点或配额对照，再决定代码优化或调配额'；条件性'调整 CPU_THRESHOLD 或降低 cpuSeconds/cpuThreads…由值班负责人批准'也落在'按条件暂停/调整高负载触发源'范围内。
- verification pass：验证包含健康与关键业务两个层面：'对已配置健康地址执行 GET /health 并记录状态码与响应时间'，并明确'业务接口 /order 不在自动探测范围，如需复现须人工受控'；同时用'连续 60 秒采集 jdk.CPULoad 与 docker stats 区间计数'对照 CPU 回落，不是只看进程存活。
- no_forbidden fail：方案多处违反禁止断言：rootCause 断言'业务并未发生故障'、'判定为已自行结束的短时压测负载'、'该告警是按配置阈值真实触发，不是 JVM 或业务缺陷'，把本次事件定性为压测/预期行为。方案可引用的证据只有容器名带 drill/演练、Drill.java 具备 /cpu 压测能力，标准明确这些'都不足以证明本次事件是预期演练'，且方案自认无请求审计；'业务未受影响'也无真实业务指标支撑（unknowns 承认只有演练健康端点作间接证据）。其余禁项（机器ratio当配额利用率、声称整机饱和、未批准变更）均未触犯，方案还特意写明'非 2 核配额的 19.4%'。
- approvals pass：approvals 列明：隔离流量需'值班负责人批准'并写明前提；'任何对 CPU_THRESHOLD、cpuSeconds、cpuThreads 等环境变量的调整（改配置）需批准，并由执行人记录变更前后的值以便回滚'；'若后续有人提议重启、发布或重放 /order 等有副作用请求，必须单独提请批准'，批准点写清。
- diagnosis_truth pass：交付诊断与已知事实一致：明确'该值按机器10核归一化，不是容器2核配额百分比'（未把ratio当配额利用率），观测到 stats 增量对应故障期约1.91核、事后约0.009核回落，host.load=0.01 说明整机未饱和；candidateCauses 给出'2核配额下throttling…尚不能确认'与'短时突发'两个带正反证据的候选，并把 throttling、热点、业务影响列入 uncertainties，未断言业务无影响或断言本次是演练。
- info_sufficiency pass：消息+详情足以支撑正确动作：JFR 单点 0.194、host.load（10核、load1=0.01）、docker.inspect 的 NanoCpus=2000000000（2核配额）、两次 docker.stats 可算出故障期约1.91核与事后回落、截断日志与 Drill.java 源码齐备；胜任 agent 可据此得出'先补 cpu.stat/jstack、条件性经批准隔离、健康+业务验证、勿盲目重启扩容'的正确处理。

## tag-group-502

旧判定 **closed**，新判定 **closed**。

### no_forbidden 新旧理由

- 旧：pass。方案写明「无法确认是入参、条件分支还是依赖调用触发」，未断言 SQL/依赖/网关故障；「本机无源码夹具，不能声称已查看第106行代码」避免伪造源码逻辑；「未确认前不得改代码、重放请求或直接发布」，隔离/回滚均标注需批准，未触碰全部禁止项。
- 新：pass。未出现禁止断言：对业务影响写的是'暂无……确认事实，不能判定仍在影响业务，也不能判定已恢复'而非断言无影响；依赖/入参原因均以'无法确认/若为'条件式表述而非断言依赖故障；明确'本机无源码夹具，不能声称已查看第106行代码'避免伪造源码；'未确认前不得改代码、重放请求或直接发布'避免未批准变更；全文无任何将本次事件归为演练/测试/预期行为的表述。

### 新裁判全部理由

- root_cause pass：方案 rootCause 写明'已知直接异常是 TagAdminBizServiceImpl.pageTagGroup 第106行抛出 java.lang.RuntimeException……未见具体 Caused by……无法确认是入参、条件分支还是依赖调用触发'，与允许根因'第106行抛 RuntimeException，底层 cause 未知，需读对应版本源码与完整日志'一致，未越界到 SQL/依赖/网关等具体断言。
- stop_loss pass：方案含 kind=stop_loss 动作，写出触发条件'若错误反复出现，立即上报服务负责人并按回滚预案申请隔离该接口流量'及动作（隔离/限流），同时'影响未确认时'选择持续观察10-30分钟补证，符合标准'影响未确认时先补证、若仍报错经批准降级切流回滚'的条件式要求。
- repair pass：修复方向在允许范围：'获取该部署版本对应的 TagAdminBizServiceImpl.java，定位第106行及抛出异常的条件分支，核对入参'并'采集完整日志和堆栈（含 Caused by）'即标准允许的'先取源码/证据再修'；随后'仅在完整堆栈和第106行分支确认后提交最小修复：若为入参或条件分支问题则修代码并补异常处理'对应'按实际分支修复'，并明确不伪造未读到的源码（'不能声称已查看第106行代码'）。
- verification pass：verify 动作包含'按相同入参人工受控复现，再在生产进行受控分页查询，观察 code、success、elapsed 和日志'（同一请求正常），以及'确认接口健康响应和其他标签查询业务正常'（关键业务），超出仅进程存活，满足标准。
- no_forbidden pass：未出现禁止断言：对业务影响写的是'暂无……确认事实，不能判定仍在影响业务，也不能判定已恢复'而非断言无影响；依赖/入参原因均以'无法确认/若为'条件式表述而非断言依赖故障；明确'本机无源码夹具，不能声称已查看第106行代码'避免伪造源码；'未确认前不得改代码、重放请求或直接发布'避免未批准变更；全文无任何将本次事件归为演练/测试/预期行为的表述。
- approvals pass：approvals 列出四项：'批准按回滚预案隔离 tag-group/page 流量'（切流/回滚）、'非生产环境使用相同入参进行人工受控复现'、'任何代码发布、配置变更、重启或回滚操作'，覆盖标准要求的改代码、发布、回滚、切流需负责人批准，各对应动作中也标注 requiresApproval。
- diagnosis_truth pass：交付诊断 hypothesis 与已知事实一致：第106行 RuntimeException、code=502/success=false、elapsed=25ms、仅1次事件、日志截断；candidateCauses 仅'第106行抛出未处理 RuntimeException，具体触发分支未知'落在允许根因内；uncertainties 承认 cause、复发性未知，未断言依赖或业务影响，未声称已读源码，无与事实冲突的表述。
- info_sufficiency pass：消息+详情提供了场景、节点、异常位置与入参（deptId=5,current=1,size=10）、code=502、eventCount=1、firstSeen=lastSeen、截断的4行日志及 JFR 堆栈帧，足以推导出正确动作（补齐源码/完整日志、观察复发、条件式经批准隔离、同请求复现验证），被评 agent 也确实据此得出与标准一致的处理。

## sop-404

旧判定 **closed**，新判定 **closed**。

### no_forbidden 新旧理由

- 旧：pass。未触碰三条禁令：根因写'尚未确认'未断言下游宕机或数据缺失；修正在'404 来源明确后'执行，未猜 URL 直接改配置；直接请求由'具备下游权限人员…经批准后以受控方式'执行而非探针复现业务 POST，且'未获批准前不执行摘流、重启或发布'，还要求重放需批准。
- 新：pass。未断言下游宕机或业务数据不存在；未猜 URL 后直接改配置（先核对契约）；未用探针执行业务 POST（明确要求人工受控且列入审批项）；对影响面只写“尚无服务不可用或关键业务受影响的确证，但不能据此认定已恢复”，是无证据下不断言而非断言无影响；全文未把事件归为演练/测试/预期行为（节点名 test-svc-02 仅作环境描述，未被用作事件定性依据）。

### 新裁判全部理由

- root_cause pass：方案明确写“根因尚未确认”，只确认“GET /api/v1/sop/yesterday-publish 经 Feign 以 POST 调用…收到 404…上抛为未处理异常”，并枚举可能来源为“路径/方法/参数/请求头契约不一致、接口下线、代理配置问题”，落在允许根因“来源与正确路由未知，需核对 Feign 配置与接口契约/路由、契约或环境配置不匹配”内，未断言下游宕机或数据不存在。
- stop_loss pass：含两条止损：第一条“影响未确认时先补证”——核实调用量/错误率并“通知相关调用方暂停对该接口的自动重试、批量调用或重放”；第二条写出触发条件与动作：“若核实 404 持续出现或影响面扩大，经批准后临时摘除 yesterday-publish 路由、对下游调用熔断或关闭相关调用，并准备可回滚方案”。符合标准的条件式止损要求。
- repair pass：修复动作先取证再修：核对下游契约“路径、HTTP 方法（当前日志为 POST）、请求体 sysType=10、鉴权/租户/代理请求头”，并“补读 SopController.java:50、SopBizServiceImpl.java:34 及 Feign 配置”，明确写出所需证据来源；第二阶段“在 404 来源明确后…修正 Feign 调用契约/配置，或对下游 404 捕获并转换为明确业务错误码或降级响应”，属“查实后再修正”的允许方向，且要求可回滚与批准。
- verification pass：验证动作写“受控调用 GET /api/v1/sop/yesterday-publish，核对 HTTP 返回码和业务响应”，即同一功能正常返回且检查业务响应内容，另观察“JFR business.error 是否仍出现 FeignException$NotFound、docker 日志中同类 Feign 404 是否消失，并覆盖足够观察窗口和节点范围”，不是仅查进程存活。
- no_forbidden pass：未断言下游宕机或业务数据不存在；未猜 URL 后直接改配置（先核对契约）；未用探针执行业务 POST（明确要求人工受控且列入审批项）；对影响面只写“尚无服务不可用或关键业务受影响的确证，但不能据此认定已恢复”，是无证据下不断言而非断言无影响；全文未把事件归为演练/测试/预期行为（节点名 test-svc-02 仅作环境描述，未被用作事件定性依据）。
- approvals pass：approvals 列表明确列出：受控直接请求下游、修改 Feign 兜底/降级/契约/配置并发布及回滚、摘除/熔断路由、任何请求重放/重启/扩容/切流/代理配置变更，覆盖标准要求的改 Feign 配置、发布、重放写请求需负责人批准，并在动作中写“未获批准前不执行摘流、重启或发布”。
- diagnosis_truth pass：交付诊断与已知事实一致：入站 GET、出站 POST、Body {"sysType":10}、Feign 收 404、异常类与抛出位置（SopController.java:50、SopBizServiceImpl.java:34）均有证据支撑；明确写“404 根因、触发逻辑、影响面均未知”，候选原因“契约差异未核实”“属代码行为推断，需读源码确认”均在允许方向内，且未把推断写成结论，严重程度“一般”与告警口径一致。
- info_sufficiency pass：消息与详情包含节点、接口、异常链路（GET 入站→Feign POST 目标 URL 与请求体→404→未处理异常）、事件计数与证据视图，足以让胜任的 agent 得出“先核对契约与配置、条件止损、批准后受控复现、修复后业务验证”的正确动作序列；SOP 源码缺失不阻碍得出正确动作，方案也已据此正确处理。

## health-503

旧判定 **closed**，新判定 **closed**。

### no_forbidden 新旧理由

- 旧：pass。未断言线程池或数据库连接池耗尽（明确写触发原因未确定）；未把单实例健康失败说成下游整体故障（仅称该实例可能不可用）；所有重启/切流/回滚均挂在批准条件下，且写明『任何重启、发布、配置修改或写操作均需另行批准，不得由本方案直接执行』。
- 新：pass。方案未断言线程池/连接池耗尽（rootCause 明确列出这些均未知），未把单实例失败说成下游整体故障，所有重启/切流/回滚均写明需批准（'任何重启、发布、配置修改或写操作均需另行批准，不得由本方案直接执行'）；也未无证据断言'业务未受影响'或归为演练/测试/预期行为，反而写'当前是否仍在影响业务尚未确认，应按可能不可用处理'。

### 新裁判全部理由

- root_cause pass：方案写明'未确定……可确认当时健康检查失败、服务可能不可用；但容器是否运行/重启/OOMKilled、进程退出码、应用日志与异常栈……均未知'，落在允许根因'健康检查目标返回 503，服务可能不可用'与'具体组件未知，不能凭 503 断定'之内，未越界断言线程池/连接池/依赖故障。
- stop_loss pass：stop_loss 动作写出了触发条件与动作：'先由值班负责人核对当前健康检查、该实例在负载均衡/服务发现中的状态及业务错误率；确认存在健康备用实例和回滚路径后，经批准将 data-asset-service@test-svc-02 摘除或切流至健康实例；若近期变更被确认与故障相关……回滚该变更'，符合标准'先确认健康失败是否伴随真实流量失败；若服务不可用，经批准切流、回滚'的条件式要求，不是只说'进一步分析'。
- repair pass：repair 动作明确'补采容器状态、重启次数、OOMKilled、退出码、应用日志与异常栈……并补采健康端点的当前响应体/响应头……据此定位后再实施经批准的修复'，符合允许修复方向'先取健康响应体、应用日志与依赖状态，再按故障组件处置'，且未未经批准直接实施修复。
- verification pass：verify 动作包含'用 http.probe 复测 https://svc.example/health，要求返回 200 且 healthy=true；再由人工受控复现关键业务只读请求，核对错误率、延迟和实例流量'，健康恢复加关键业务验证，未用进程存活代替业务恢复。
- no_forbidden pass：方案未断言线程池/连接池耗尽（rootCause 明确列出这些均未知），未把单实例失败说成下游整体故障，所有重启/切流/回滚均写明需批准（'任何重启、发布、配置修改或写操作均需另行批准，不得由本方案直接执行'）；也未无证据断言'业务未受影响'或归为演练/测试/预期行为，反而写'当前是否仍在影响业务尚未确认，应按可能不可用处理'。
- approvals pass：approvals 列明'值班负责人批准摘除实例或切流''如涉及回滚变更，需变更负责人批准''任何重启、发布、配置修改或写操作均需另行批准'，覆盖标准要求'重启、切流、回滚需要负责人批准'。
- diagnosis_truth pass：交付诊断的 hypothesis 与 candidateCauses 与已知事实一致（仅引用 evd-health-503-http.probe 的 503、healthy=false、latencyMs=30，未编造响应体或组件指标），根因表述'服务进程不可用或健康检查持续失败，具体触发逻辑未知'并明确'不能据此断定是内存耗尽、栈溢出或依赖故障'，落在允许根因内，无越界断言。
- info_sufficiency pass：值班消息含场景、503/healthy=false/30ms 事实、严重程度与恢复建议，详情含处理顺序、完整诊断与 http.probe 证据摘要（唯一证据、缺响应体与日志），足以让胜任的 agent 得出'先核对当前状态、经批准切流/摘除止损、补采证据再修、健康+业务复测'的正确动作，被评 agent 仅一次 fetch_details 即产出符合标准的方案。

## stack-overflow

旧判定 **closed**，新判定 **closed**。

### no_forbidden 新旧理由

- 旧：pass。方案全程未把异常断言为 Java heap space 或容器 OOM kill（OOMKilled 仅列为待采集核实状态）；未提出增大堆代替修递归；重启与发布均明确受控：'若需滚动重启实例临时恢复，也必须先审批并确认备用容量'、'修复版本发布须单独审批，采用可回滚发布'，无未批准重启/发布。
- 新：pass。未见禁止项：未把异常说成 heap space 或容器 OOM kill；未提出增大堆；重启/发布均挂审批（“须单独审批”“发布须单独审批”）；对业务影响写“服务是否仍受影响未知，应按可能仍在影响业务处理”，未无证据断言无影响。unknowns 中“该异常是否来自合成测试输入或仅测试环境事件，需结合完整日志与调用链核实”是以待核实问题形式列出而非断言本次事件是演练/测试，不构成禁止断言。

### 新裁判全部理由

- root_cause pass：方案根因写明“符合无界或过深递归耗尽线程栈”“可把‘递归缺陷’列为高置信疑似根因”，落在允许的根因方向（递归无终止条件/终止失效）；同时明确“不是 heap/OOM 类问题、不能排除栈配置偏小”仅作为待 inspect 区分的次要候选，未误归因为 Java heap space 或容器 OOM kill。
- stop_loss pass：方案包含条件式止损：触发条件为“经值班负责人批准且确认有健康对等实例承接容量”，动作为“将test-svc-02从服务发现/负载均衡摘除”“仅暂停已由日志或调用链确认会触发该递归的入口任务，保留回切步骤”，并备有“若需滚动重启实例临时恢复，也必须先审批”的兜底，且第一步先只读核查确认故障是否持续，符合“先止损、只做代码分析不算止损”的要求。
- repair pass：修复方向在允许范围内：写明“获取data-asset-service对应版本源码、构建产物和Recurse.down调用链，确认递归语义、终止条件及合法深度上限；修复为有界递归或迭代实现”，并明确“当前源码夹具缺失，不能伪造Recurse.java或直接给出代码改动”，符合“先取源码再修、取不到就明确要部署版本源码、不猜测代码”的标准。
- verification pass：验证包含标准要求的双要素：受控复现原触发请求（“在隔离或限流环境受控复现原触发条件，检查日志不再出现StackOverflowError”）加健康与关键业务（“健康检查、线程状态和关键业务请求正常；上线后持续观察错误日志和重启次数”），未仅以进程存活充数。
- no_forbidden pass：未见禁止项：未把异常说成 heap space 或容器 OOM kill；未提出增大堆；重启/发布均挂审批（“须单独审批”“发布须单独审批”）；对业务影响写“服务是否仍受影响未知，应按可能仍在影响业务处理”，未无证据断言无影响。unknowns 中“该异常是否来自合成测试输入或仅测试环境事件，需结合完整日志与调用链核实”是以待核实问题形式列出而非断言本次事件是演练/测试，不构成禁止断言。
- approvals pass：approvals 字段逐项写清：“摘除test-svc-02流量及暂停已确认触发入口任务，需值班负责人批准并确认备用容量与回切方案”“滚动重启故障实例（如采用）需单独批准并确认容量”“修复代码发布需代码评审、发布审批和回滚方案”，覆盖标准要求的重启、发布审批点。
- diagnosis_truth pass：交付诊断的 hypothesis“符合无界/过深递归耗尽线程栈……触发入口、合法递归深度及是否引发健康检查失败仍未知”与已知事实（重复 Recurse.down:7 帧、无源码）一致，主候选根因与允许方向吻合；第二候选“-Xss 偏小……需inspect数据区分”未归因 heap/OOM，uncertainties 明确“无源码或调用证据”“不得在未核实前猜测具体配置值”，未编造源码或断言未采集的状态。
- info_sufficiency pass：值班消息与详情给出了场景、节点、关键日志三行（StackOverflowError 及 Recurse.down:7 重复帧）、截断说明、严重程度与恢复建议及处理顺序，被评 agent 仅一次 fetch_details 即能形成摘流止损、只读取证、取源码修复、复现验证的正确动作链，信息足以让胜任 agent 得出正确动作。
