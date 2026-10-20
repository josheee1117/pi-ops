import {
  MAX_SPECIALISTS_PER_INVESTIGATION,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  SPECIALIST_ROLES,
  validateSpecialistFinding,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { parseModelJson, type RuntimeModel } from './model.js';

export { MAX_SPECIALISTS_PER_INVESTIGATION, SPECIALIST_ROLES };

/** Phone notification shape. Evidence limits still constrain the judgment, not the prose. */
export const ON_CALL_BRIEF = [
  '值班人在手机上读完。hypothesis、recommendation、summary、hypotheses 是通知正文，不是调查底稿。',
  'Evidence ID、哈希和 job id 只放 JSON 数组，禁止写入上述正文。',
  'hypothesis 与 summary 用换行写成三行，总长不超过 320 个字符：',
  '结论：一句话，先写直接原因。',
  '依据：最多两句，只写支撑该结论的观测。时间写到分钟。',
  '未知：一句话。没有会改变下一步的未知就写「未知：无」。',
  'recommendation 最多三条，每条一行，总长不超过 180 个字符。写成可执行的下一步，不重复依据，不附 ID。',
  'hypotheses 每条只写一句话，不附 ID。',
  '证据限制只约束判断。不要把通用保留写进正文，例如运行中不能证明 JVM 健康、事后采样不能代表故障窗口、日志片段不是完整窗口。只有该保留本身就是本次结论时才写。',
].join('\n');

/** Cross-layer inference limits apply to both specialists and final synthesis. */
export const CURRENT_EVIDENCE_LIMITS = [
  '用当前成功 Evidence 支撑判断。相关 Evidence ID 全部写入 JSON 数组，不要写入正文。',
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
  const response = await model.invoke({
    system: [
      `SPECIALIST_ROLE=${role}`,
      'Return ONLY one JSON object. No markdown. No extra text.',
      'Required keys: role, hypotheses, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence, confidence, summary, status.',
      'status must be completed or failed. confidence is 0 to 1. missingEvidence items must be allowed capability classes.',
      'hypotheses must be an array of at most 5 non-empty strings. summary must be one non-empty string of at most 2000 characters, not an object.',
      'Do not persist chain-of-thought.',
      'Write hypotheses and summary in concise Simplified Chinese. Keep JSON keys, enum values, and technical identifiers unchanged. Evidence IDs in JSON arrays stay unchanged.',
      ON_CALL_BRIEF,
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
  });
  let parsedJson: unknown;
  try {
    parsedJson = parseModelJson(response.text);
  } catch (error) {
    throw new Error(`invalid specialist json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = validateSpecialistFinding(normalizeSpecialistPayload(parsedJson));
  if (!parsed.success) throw new Error(`invalid specialist output: ${parsed.message}`);
  const finding = parsed.value;
  if (finding.role !== role) throw new Error('specialist role mismatch');
  const ids = [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds];
  if (ids.some((id) => !currentIds.has(id))) {
    throw new Error('specialist cited evidence that does not belong to the current incident');
  }
  return {
    finding,
    inputTokens: response.inputTokens ?? 0,
    outputTokens: response.outputTokens ?? 0,
  };
}
