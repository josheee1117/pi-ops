import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toOnCallBrief } from '../on-call-brief.js';
import { createWeComNotifier } from '../notifier.js';

const tagGroup = {
  hypothesis: '已观测事实：2026-10-20T01:21:43.948Z 记录 1 次 business.error（Unhandled request exception）；JFR 显示 POST /api/v1/tag/admin/tag-group/page 抛出 java.lang.RuntimeException，JFR 栈顶与 docker.logs 的 Caused by 均指向 com.mbkj.dap.tag.impl.TagAdminBizServiceImpl.pageTagGroup(TagAdminBizServiceImpl.java:106)。01:21:43.949 的拦截器日志显示同一请求体 deptId=5,current=1,size=10 返回 code=502、msg=系统异常、success=false，耗时 25ms。01:21:58.212Z 的 docker.inspect 显示容器 /dataasset 处于 running、OOMKilled=false、RestartCount=0、Memory=2GiB、NanoCpus=2e9，采集晚于事件约 14.26 秒，不能据此判断 JVM 堆健康。01:21:58.215Z 的 docker.logs 仅可见 ping SQL 与 t_form_import_task 相关 SQL 片段，未包含该请求的异常上下文，不能视为完整日志或完整故障窗口。01:22:22.332Z 的另一份 docker.logs 可见 Tomcat 调用栈和上述 RuntimeException 文本。01:22:23.377Z 的 docker.stats 在事件后约 39 秒采样，1 秒区间 CPU 增量很低、内存 usage 约 1.2GB/2GiB、pids=198，但不能代表 01:21:43 时段的峰值、持续性和 throttling。较可能原因：异常发生在 pageTagGroup 第106行附近，可能是业务逻辑主动抛出或捕获后包装重抛的运行时异常；具体触发分支和底层 cause 未知，不能把库存校验、条件判断、结果映射或外部依赖调用列为较可能原因。未知：异常根因与 cause、是否可复现或持续、影响范围、JVM 堆 OOM、故障时 CPU/内存峰值与限流情况，以及可见 SQL 与本次异常的关联；异常文本只证明应用报错，不证明外部依赖故障。',
  recommendation: [
    '1. 拉取 01:21:43 前后完整应用日志，补全异常 cause/Caused by 链、SQL/DAO 异常和线程信息，确认是否仅此一笔。',
    '2. 阅读 TagAdminBizServiceImpl.java:106 及 pageTagGroup 调用链，确认抛出或包装逻辑、触发条件和返回码 502 的映射位置。',
    '3. 用相同请求体 deptId=5,current=1,size=10 对 POST /api/v1/tag/admin/tag-group/page 做人工受控复现，记录是否稳定复现、耗时和错误响应。',
    '4. 检查该实例 JVM 堆/GC 日志与 OOM 记录，并核对 01:21:43 前后内存、CPU 峰值和容器限流；当前 running 与 OOMKilled=false 只代表采集时状态。',
    '5. 按代码实际调用链检查涉及的 DB/缓存/下游连接池、超时和错误日志；现有证据未证明外部依赖故障。',
    '6. 核对 docker.logs 中 t_form_import_task SQL 与本次请求是否同线程、同时间窗口，未证实前不要归因。',
  ].join('\n'),
};

const sop404 = {
  hypothesis: '已观测事实：01:46:29.415Z 与 01:46:55.878Z 各出现1次 business.error，均为 GET /api/v1/sop/yesterday-publish 的 Unhandled request exception，异常类 feign.FeignException$NotFound；栈显示 SopController.getSysPublishYesterday(SopController.java:50) -> SopBizServiceImpl.getSysPublishYesterday(SopBizServiceImpl.java:34) -> Feign 代理 getSysPublishYesterday 抛出，可确认异常类型、调用链位置及 Feign 收到404，不能确认触发分支。01:46:58.277Z docker.inspect 显示 /dataasset running、OOMKilled=false、RestartCount=0、Memory=2GiB、NanoCpus=2e9；01:47:12.226Z docker.stats 的 read/preread 约1.003s区间CPU增量约10.678ms、内存约1.206GB/2GiB、pids=195；采样均在事件后，不能代表故障窗口峰值或JVM堆健康。docker.logs仅见20行Tomcat过滤器栈片段，无异常头和完整上下文。较可能原因：Feign 目标端点/路由返回404，可能为路径或服务名/网关/接口版本不匹配；具体触发逻辑未知，需读 Feign 配置、下游路由和代码确认，异常类不证明外部依赖整体故障或业务数据异常。未知：两次事件是否重试/定时任务、404真实来源、影响范围、JVM堆OOM及故障时CPU/内存峰值和限流。',
  recommendation: [
    '1. 人工受控复现 GET /api/v1/sop/yesterday-publish，记录请求参数、响应码/响应体和时间，确认是否稳定返回404。',
    '2. 核对 SopBizServiceImpl.java:34 的 Feign 客户端定义、目标服务名/URL、路径和版本，与下游实际路由/接口比对，定位404由目标服务、网关还是路径不匹配产生。',
    '3. 检查下游服务是否提供该端点及网关路由/鉴权配置，并读取 SopBizServiceImpl/SopController 相关代码确认触发分支。',
    '4. 拉取事件前后完整应用日志、访问日志和调用链，确认01:46:29.415Z与01:46:55.878Z是否同一请求重试或定时任务，间隔约26.46s。',
    '5. 补采事件窗口的 docker.stats、host.memory、host.load 及JVM堆指标；当前容器running和OOMKilled=false不能证明JVM健康。',
  ].join('\n'),
};

const sopUrl = {
  hypothesis: '已观测：01:56:00.246Z 与 01:56:02.045Z 各记录1次 business.error，入站操作均为 GET /api/v1/sop/yesterday-publish，异常类均为 feign.FeignException$NotFound；栈定位到 SopController.getSysPublishYesterday(SopController.java:50) → SopBizServiceImpl.getSysPublishYesterday(SopBizServiceImpl.java:34) → Feign 代理 getSysPublishYesterday，异常由 Feign 错误解码器抛出，可确认异常类型、调用链位置以及该次 Feign 调用收到 404 类客户端错误状态（jfr-b03ebc2616a2c53e4d32adefc4f234d9d070e68752bfec9ab95014d2d98072cb、jfr-05e8b9eeffefe569ceaabf455f6d7e32e48bede308e856a5ed1c5f5b7d7871ef）。01:56:02.034Z 的20行可见 docker.logs 片段显示 SopController 处理 sysType=10，随后 Feign Request: [SopFeignClient#getSysPublishYesterday(SysPublishReqDto)] - Method: POST - URL: https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday，Body: {"sysType":10}，与第二次事件时间接近（inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.logs）。01:56:27.722Z 的 job docker.logs 为 truncated=true 且无可见行，不能视为完整日志或完整故障窗口（job-inc-f1733c3c-baf7-47b8-a48b-2ee70fa7bebf-evidence-docker.logs）。01:56:27.719Z docker.inspect 显示 /dataasset 运行中、OOMKilled=false、RestartCount=0、Memory=2GiB、NanoCpus=2e9；这只说明容器未因 OOM 被杀且当前在运行，不能保证 JVM 堆健康（job-inc-f1733c3c-baf7-47b8-a48b-2ee70fa7bebf-evidence-docker.inspect）。01:56:46.019Z docker.stats 为事后约44秒采样，read/preread 约1.00255s区间容器CPU增量约3.692ms，折合该区间平均约0.00368核（相对8核机器总容量约0.046%）、内存约1.206GB/2GiB、pids=199，不能代表故障窗口峰值、持续性或 CPU throttling（inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.stats）。较可能原因：本次直接近端原因是 Feign 调用 getSysPublishYesterday 的下游 POST 返回404；404 的具体来源和触发逻辑仍未知，需读代码、核对 Feign 配置、proxy-test 路由和接口契约确认，异常类本身不能证明外部依赖整体故障或业务数据异常。未知：404 的响应体与真实来源、触发分支、两次事件是否同一请求链路或短时重试/定时触发、影响范围、JVM 堆是否发生 OutOfMemoryError、故障窗口 CPU/内存峰值与限流情况。',
  recommendation: [
    '1) 在 01:56:00–01:56:03 时间窗核对 proxy-test 网关/下游访问日志，确认 POST https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 的响应码、响应体和路由命中情况，定位 404 来源（jfr-b03ebc2616a2c53e4d32adefc4f234d9d070e68752bfec9ab95014d2d98072cb、jfr-05e8b9eeffefe569ceaabf455f6d7e32e48bede308e856a5ed1c5f5b7d7871ef、inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.logs）。',
    '2) 读取 SopFeignClient 配置及 SopBizServiceImpl.java:34、SopController.java:50，核对 Feign 的 URL/路径、HTTP 方法、接口版本和网关映射是否与下游契约一致（jfr-b03ebc2616a2c53e4d32adefc4f234d9d070e68752bfec9ab95014d2d98072cb、inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.logs）。',
    '3) 在受控环境用相同 Body {"sysType":10} 人工复现该业务 POST，记录下游响应码、响应体、headers 和调用链（inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.logs）。',
    '4) 查看下游服务对应时间窗日志与发布记录，确认 /open/api/lx/findPublishYesterday 是否存在、是否近期变更或下线（inv-isess-9259915e-1e89-421f-803f-b0757ca068ec-evidence-docker.logs）。',
    '5) 单独补查 JVM 堆、GC、线程与容器连续 CPU throttling 指标，确认故障前后是否有 OutOfMemoryError 或限流；当',
  ].join('\n'),
};

describe('on-call brief', () => {
  it('keeps the tag-group exception and drops container sampling', () => {
    const brief = toOnCallBrief(tagGroup.hypothesis, tagGroup.recommendation);
    assert.deepEqual(brief, {
      conclusion: '异常发生在 pageTagGroup 第106行附近，可能是业务逻辑主动抛出或捕获后包装重抛的运行时异常。具体触发分支和底层 cause 未知。返回 502。',
      evidence: 'POST /api/v1/tag/admin/tag-group/page，异常 RuntimeException，位置 TagAdminBizServiceImpl.pageTagGroup:106。请求 deptId=5,current=1,size=10，返回 502。',
      unknown: '异常根因与 cause、是否可复现或持续、影响范围、可见 SQL 与本次异常的关联。',
      steps: [
        '拉取 01:21:43 前后完整应用日志，补全异常 cause/Caused by 链、SQL/DAO 异常和线程信息，确认是否仅此一笔。',
        '阅读 TagAdminBizServiceImpl.java:106 及 pageTagGroup 调用链，确认抛出或包装逻辑、触发条件和返回码 502 的映射位置。',
        '用相同请求体 deptId=5,current=1,size=10 对 POST /api/v1/tag/admin/tag-group/page 做人工受控复现，记录是否稳定复现、耗时和错误响应。',
      ],
    });
    assert.doesNotMatch(JSON.stringify(brief), /OOMKilled|docker\.stats|库存校验/);
  });

  it('keeps the Feign 404 and the downstream URL', () => {
    const early = toOnCallBrief(sop404.hypothesis, sop404.recommendation);
    assert.match(early.conclusion, /返回404/);
    assert.match(early.evidence, /GET \/api\/v1\/sop\/yesterday-publish/);
    assert.match(early.evidence, /FeignException\$NotFound/);
    assert.equal(early.steps.length, 3);
    assert.doesNotMatch(JSON.stringify(early), /OOMKilled|补采/);

    const located = toOnCallBrief(sopUrl.hypothesis, sopUrl.recommendation);
    assert.equal(located.conclusion, '下游 https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404。来源还不清楚。');
    assert.match(located.evidence, /sysType.:10/);
    assert.equal(located.steps.length, 3);
    assert.match(located.steps[0]!, /proxy-test/);
    assert.doesNotMatch(JSON.stringify(located), /jfr-|inv-isess-|OOMKilled|truncated/);
  });

  for (const { facts, expected } of [
    { facts: '拦截器日志返回 code=502。', expected: '直接原因未确认，已观测到返回 502。' },
    { facts: 'Feign 调 https://downstream.example/api 失败。', expected: '直接原因未确认。' },
  ]) {
    it(`states the uncertainty and observed status when all cause clauses are filtered: ${facts}`, () => {
      const cause = '异常文本只证明应用报错，不证明外部依赖故障。';
      const brief = toOnCallBrief(`已观测事实：${facts}较可能原因：${cause}`, '核对应用日志。');
      assert.equal(brief.conclusion, expected);
    });
  }

  it('preserves ordinary inc-prefixed text instead of treating it as an identifier', () => {
    const brief = toOnCallBrief(
      '已观测事实：sync-inc-20261020 批次失败。较可能原因：inc-analysis 报告显示异常。',
      '核对 inc-analysis 报告。',
    );
    assert.equal(brief.conclusion, 'inc-analysis 报告显示异常。');
    assert.equal(brief.evidence, 'sync-inc-20261020 批次失败。');
    assert.deepEqual(brief.steps, ['核对 inc-analysis 报告。']);
  });

  for (const prefix of ['evd', 'inc', 'isess']) {
    it(`preserves non-UUID ${prefix} text in every brief field`, () => {
      const text = `${prefix}-analysis`;
      const brief = toOnCallBrief(
        `结论：${text} 报告显示异常。依据：${text} 记录批次失败。未知：${text} 的触发条件。`,
        `核对 ${text} 报告。`,
      );
      assert.equal(brief.conclusion, `${text} 报告显示异常。`);
      assert.equal(brief.evidence, `${text} 记录批次失败。`);
      assert.equal(brief.unknown, `${text} 的触发条件。`);
      assert.deepEqual(brief.steps, [`核对 ${text} 报告。`]);
    });
  }

  it('preserves the cause of a local health check failure instead of calling it downstream', () => {
    const brief = toOnCallBrief(
      '已观测事实：健康检查 https://svc.example/health 返回 503。较可能原因：应用线程池耗尽。',
      '核对线程池。',
    );
    assert.equal(brief.conclusion, '应用线程池耗尽。返回 503。');
  });

  for (const cue of ['Feign', '调用', '下游', '远程']) {
    for (const source of ['facts', 'cause']) {
      it(`keeps the downstream URL when ${source} identifies an external call with ${cue}`, () => {
        const facts = `${source === 'facts' ? cue : ''} https://downstream.example/api 返回 503。`;
        const cause = `${source === 'cause' ? cue : ''}请求处理失败。`;
        const brief = toOnCallBrief(`已观测事实：${facts}较可能原因：${cause}`, '核对调用日志。');
        assert.equal(brief.conclusion, '下游 https://downstream.example/api 返回 503。');
      });
    }
  }

  it('keeps the legacy non-UUID identifier filtering', () => {
    const brief = toOnCallBrief(
      '结论：应用请求失败（jfr-12345678、job-inc-12345678、inv-isess-12345678、inv-12345678）。',
      '核对日志。',
    );
    assert.equal(brief.conclusion, '应用请求失败。');
  });

  it('does not replace a cause with a downstream URL when no status is observed', () => {
    const brief = toOnCallBrief(
      '已观测事实：Feign 调 https://downstream.example/api 失败。较可能原因：应用请求处理失败。未知：根因。',
      '核对应用日志。',
    );
    assert.equal(brief.conclusion, '应用请求处理失败。');
  });

  for (const prefix of ['evd', 'inc', 'isess', 'job-inc', 'inv-isess', 'inv', 'jfr']) {
    it(`removes ${prefix} identifiers from every brief field`, () => {
      const id = `${prefix}-5f0a1c2e-1234-4567-890a-bcdef0123456`;
      const brief = toOnCallBrief(
        `结论：应用请求处理失败（${id}）。依据：日志记录异常（${id}）。未知：触发条件（${id}）。`,
        `核对应用日志（${id}）。`,
      );
      assert.doesNotMatch(JSON.stringify(brief), /evd-|inc-|isess-|job-|inv-|jfr-/);
      assert.equal(brief.conclusion, '应用请求处理失败。');
      assert.equal(brief.evidence, '日志记录异常。');
      assert.equal(brief.unknown, '触发条件。');
      assert.deepEqual(brief.steps, ['核对应用日志。']);
    });
  }

  it('leaves a short report and a resource finding intact', () => {
    const short = toOnCallBrief('健康接口返回 503，具体失败条件尚不明确。', '检查健康接口详情。\n核对应用日志。');
    assert.equal(short.conclusion, '健康接口返回 503，具体失败条件尚不明确。');
    assert.equal(short.evidence, '');
    assert.deepEqual(short.steps, ['检查健康接口详情。', '核对应用日志。']);

    const labeled = toOnCallBrief('结论：下游返回 404。\n依据：body 为 sysType=10。\n未知：无', '查访问日志。');
    assert.equal(labeled.conclusion, '下游返回 404。');
    assert.equal(labeled.evidence, 'body 为 sysType=10。');
    assert.equal(labeled.unknown, '');

    const oom = toOnCallBrief(
      '已观测事实：docker.inspect 显示 OOMKilled=true，ExitCode=137。较可能原因：容器因内存超限被杀。未知：是堆溢出还是容器限额过小。',
      '1. 看容器内存限额\n2. 看 JVM 堆是否 OOM',
    );
    assert.match(oom.conclusion, /内存超限被杀/);
    assert.match(oom.evidence, /OOMKilled=true/);
    assert.equal(oom.steps.length, 2);
  });

  it('renders the located 404 as one screen', async () => {
    let content = '';
    const notifier = createWeComNotifier({
      webhookUrl: 'https://example.test/hook', timeoutMs: 100, maxResponseBytes: 128,
      fetch: async (_url, init) => {
        content = JSON.parse(init?.body as string).markdown.content;
        return new Response(JSON.stringify({ errcode: 0 }));
      },
    });
    await notifier.send({
      schemaVersion: 1,
      notificationId: 'n-1',
      type: 'INVESTIGATION_COMPLETED',
      incident: {
        id: 'inc-f1733c3c-baf7-47b8-a48b-2ee70fa7bebf',
        service: 'data-asset-service', nodeId: 'test-svc-02', type: 'business.error',
        severity: 'error', state: 'OPEN',
        firstSeen: '2026-10-20T01:56:00.246Z', lastSeen: '2026-10-20T01:56:02.045Z',
      },
      facts: { eventCount: 2, evidenceIds: [] },
      analysis: {
        investigationSessionId: 's', reasoningResultId: 'r', confidence: 0.78,
        hypothesis: sopUrl.hypothesis, recommendation: sopUrl.recommendation,
      },
    });
    assert.ok(content.startsWith('### data-asset-service 诊断完成\n**下游 https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday 返回 404。'));
    assert.ok(content.indexOf('**下游') < content.indexOf('机器：'));
    assert.ok(content.indexOf('**下一步**') < content.indexOf('模型自评'));
    assert.equal((content.match(/^\d+\. /gm) ?? []).length, 3);
    assert.ok(Buffer.byteLength(content) < 2000);
    assert.doesNotMatch(content, /jfr-|OOMKilled/);
  });
});
