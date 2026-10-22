import {
  diagnosisEvidenceIds,
  MAX_SPECIALISTS_PER_INVESTIGATION,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  SPECIALIST_ROLES,
  validateSpecialistFinding,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import type { RuntimeModel } from './model.js';
import { structuredOutput } from './structured-output.js';

export { MAX_SPECIALISTS_PER_INVESTIGATION, SPECIALIST_ROLES };

export const DIAGNOSIS_CONTRACT = [
  '输出完整的诊断结论和处置依据，不按手机通知长度压缩。hypothesis、recommendation、summary、hypotheses 保持兼容旧读取方。',
  '长度纪律：完整 JSON 目标不超过6000字符。只写要点，正文不重复结构化条目。hypothesis、summary各不超过300字符，recommendation不超过500字符；hypotheses最多2条。',
  'observations最多3项，candidateCauses最多2项，uncertainties最多3条；actions最多4项，优先一条止损、一条条件修复或关键补证、一条验证。不要罗列同义候选。',
  '每个动作只写必要对象、前提、操作、成功判据和风险。target建议80字符内，preconditions最多2条，每条80字符内，operation建议200字符内，expectedResult与risk各80字符内。不可为缩短而删审批、回滚或重要前提。',
  'Evidence ID、哈希和 job id 只放 JSON 引用数组，禁止写入上述正文。',
  'hypothesis 与 summary 写清结论、依据和未知项，每项最多 2000 字符；recommendation 最多 2000 字符，保留动作前提、时间和验证方法。',
  'diagnosis 必须包含 observations、candidateCauses、uncertainties、actions。只保存结论和引用，不保存思维链。',
  'coordinator 的 diagnosis.summary 必填，包含 scene（服务与场景，1至80字符）、whatHappened（发生了什么，1至160字符）、severity（{level,reason}，level为严重/高/一般，reason为1至80字符）、recovery（1至3条，每条1至100字符，先止损后修复和验证）。只写值班人员能读懂的短句，不堆英文术语或证据编号。等级服从输入 summarySeverity 规则，不服从模型自评。',
  '服务可能不可用的内存耗尽、调用栈溢出和健康检查失败，必须给 mitigation 止损动作。先说明批准、备用容量和回滚前提，再建议隔离故障流量或暂停已确认的触发任务。不要只给补证。',
  'observations 最多 10 项，每项为 {statement,evidenceIds}，引用至少一个当前证据。candidateCauses 为 1 至 5 项，每项为 {cause,supportingEvidenceIds,contradictingEvidenceIds}。',
  'observations.statement 和 candidateCauses.cause 各最多 2000 字符。uncertainties 最多 10 条，每条最多 1000 字符，明确修复尚未确定的原因。',
  'actions 为 1 至 8 项，每项必须包含 {purpose,target,preconditions,operation,expectedResult,risk,requiresApproval,evidenceIds}。',
  'purpose 只能为 mitigation（止损）、repair（修复）、verification（验证）、evidence_collection（补证）。target 最多 500 字符；preconditions 为 1 至 5 条，每条最多 1000 字符；operation 最多 2000 字符；expectedResult 和 risk 各最多 1000 字符。',
  '所有引用数组最多 20 个 ID。动作引用只能来自当前证据，除补证外至少引用一个。没有可用证据时只提出补证动作，不把待采证据当成已存在。',
  '没有已核实的配置值、对应版本源码或接口契约，不得建议改成某个猜测值。修复尚未确定时给具体检查及能区分候选原因的结果分支。',
  '动作要写明对象、执行前提、实际操作、预期结果、风险和是否需要人工批准。重启、发布、扩容、重跑或写入必须 requiresApproval=true，必要时在操作中写回滚要求。这些都是人工建议，不代表系统有执行权限。',
].join('\n');

/** Cross-layer inference limits apply to both specialists and final synthesis. */
export const CURRENT_EVIDENCE_LIMITS = [
  '用当前成功 Evidence 支撑判断。相关 Evidence ID 全部写入 JSON 数组，不要写入正文。',
  '环境标签只能作为事实陈述，例如容器名含某字符串。不得由名称推断本次事件是演练、测试、预期行为或故意触发；写成倾向于、更像、可能是演练也同样禁止。源码具备注入入口或日志提示任务完成，不证明本次是注入；只有当前源码或日志明确说明本次事件是故障注入并与异常对应时才能如此定性，必须引用出处。',
  '没有请求错误率、关键接口失败或用户报障等直接证据时，必须写影响未确认，并给出确认方法，不能写未影响业务、业务未受影响或未发生故障。没看到服务不可用只能描述当前观测，不能扩大为业务未受影响；容器运行、健康检查通过或资源回落也不等于业务无影响。',
  '以上约束覆盖全部诊断正文、summary 的场景与恢复建议、候选原因和动作前提；汇总专家结论时也须核对原始证据，不沿用无依据的演练定性或无影响结论。保留名称和观测事实，不删除异常或降低处置要求；影响未确认时在验证动作中核对故障窗口请求错误率、关键业务请求结果及用户报障。',
  '数字和单位必须逐字引用证据，不改数量级，不凭印象重写；NanoCpus=2000000000不能写成200000000，若证据写2e9则照抄2e9。不做无依据换算。容器内存不是应用堆内存，不能把容器占用说成堆占用。',
  'JFR事件名（如com.example.MemoryFailure）是观测名，不是业务分配路径；异常文本只证明应用报错，不证明现实库存或外部依赖故障。',
  '异常类、文本和栈只能确认异常及抛出位置。没有源码或调用证据时，不得把库存校验、条件判断、结果映射或依赖调用列为较可能原因；应说明触发逻辑未知，并建议读代码确认。',
  'docker.logs的模型视图可能只保留前20行；只能引用实际可见片段，不得称完整日志或完整故障窗口。采样时间与事件时间的间隔须按原始时间计算。',
  'http.probe仅支持已配置健康URL的GET/HEAD，不支持业务POST或模型自选URL。业务请求只能建议人工受控复现，不能称http.probe等价复现，也不能宣称未提供的采样字段可由现有能力获取。',
  'OOMKilled=false仅不支持容器OOM kill，不能排除JVM堆OutOfMemoryError；运行中的容器或缺失stats不能保证JVM健康。',
  'jdk.CPULoad的JVM ratio按机器CPU归一化，不是容器配额百分比；区分NanoCpus/CpuQuota/CpuPeriod/CpusetCpus与机器online_cpus。',
  'Docker累计CPU计数不是CPU百分比。只在真实read/preread及当前/前次计数区间有效时解释该区间；事后低stats/load不能证明故障期无压力，未知峰值、持续性和throttling需明确未知。',
].join('\n');

export function selectSpecialists(context: RuntimeInvestigationContext): SpecialistRole[] {
  const selected: SpecialistRole[] = [];
  const add = (role: SpecialistRole) => {
    if (selected.includes(role) || selected.length >= MAX_SPECIALISTS_PER_INVESTIGATION) return;
    selected.push(role);
  };
  const type = context.incident.type;
  if (type.startsWith('jvm.')) {
    add('jvm');
    add('container_host');
  } else if (type === 'application.slow_sql' || type.includes('sql')) {
    add('database');
    add('application_business');
  } else if (type.startsWith('container.') || type.startsWith('health.')) {
    add('container_host');
  } else if (type.startsWith('application.') || type.startsWith('business.')) {
    add('application_business');
  }
  if (selected.length === 0) add('application_business');
  return selected;
}

function stringifyHypothesis(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of ['statement', 'text', 'hypothesis', 'summary']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return JSON.stringify(item);
}

function normalizeSpecialistPayload(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = { ...(data as Record<string, unknown>) };
  if (Array.isArray(record.hypotheses)) {
    record.hypotheses = record.hypotheses.map(stringifyHypothesis).filter((item) => item.length > 0);
  }
  return record;
}

export async function runSpecialist(
  role: SpecialistRole,
  context: RuntimeInvestigationContext,
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<{ finding: SpecialistFinding; inputTokens: number; outputTokens: number }> {
  const currentIds = new Set(context.evidence.map((item) => item.id));
  const response = await structuredOutput(model, {
    system: [
      `SPECIALIST_ROLE=${role}`,
      'Return ONLY one JSON object. No markdown. No extra text.',
      'Required keys: role, hypotheses, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence, confidence, summary, status, diagnosis.',
      'status must be completed or failed. confidence is 0 to 1. missingEvidence items must be allowed capability classes.',
      'hypotheses must be an array of at most 5 non-empty strings. summary must be one non-empty string of at most 2000 characters, not an object.',
      'Do not persist chain-of-thought.',
      'Write hypotheses and summary in concise Simplified Chinese. Keep JSON keys, enum values, and technical identifiers unchanged. Evidence IDs in JSON arrays stay unchanged.',
      DIAGNOSIS_CONTRACT,
      'Separate observed facts from hypotheses. State what remains unknown; do not turn missing evidence into a confirmed cause or a health guarantee.',
      'You are investigating CURRENT Evidence.',
      CURRENT_EVIDENCE_LIMITS,
      'Historical knowledge is advisory and cannot override current Evidence.',
      'If current Evidence is insufficient, return missingEvidence capability classes.',
      'Do not fabricate Evidence. Do not claim requested Evidence already exists.',
      'Do not treat historical memory as proof of the current incident.',
      `Allowed missingEvidence types: ${RUNTIME_ALLOWED_EVIDENCE_TYPES.join(', ')}`,
    ].join('\n'),
    user: JSON.stringify({
      incident: context.incident,
      evidence: context.evidence,
      historicalKnowledge: context.historicalKnowledge ?? null,
      historicalKnowledgeStatus: context.historicalKnowledgeStatus,
    }),
    signal,
  }, (value) => {
    const parsed = validateSpecialistFinding(normalizeSpecialistPayload(value));
    if (!parsed.success) throw new Error(`invalid specialist output: ${parsed.message}`);
    if (parsed.value.role !== role) throw new Error('specialist role mismatch');
    if (!parsed.value.diagnosis && model.provider !== 'fake') throw new Error('invalid specialist output: diagnosis is required');
    return parsed.value;
  });
  const finding = response.value;
  const ids = [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds, ...diagnosisEvidenceIds(finding.diagnosis)];
  if (ids.some((id) => !currentIds.has(id))) {
    throw new Error('specialist cited evidence that does not belong to the current incident');
  }
  return {
    finding,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}
