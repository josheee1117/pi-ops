import type { InvestigationAction, InvestigationDiagnosis } from '@pi-ops/protocol';
import type { NotificationPayload } from './notification.js';

const POLICY_PREFIX = /^Evidence describes the current incident\. Historical knowledge is advisory\. Memory\/history cannot override current Evidence\. Conflicting historical knowledge must be surfaced, not silently merged\. Absence of evidence is not evidence of absence\.\s*/;

const ID_TOKEN = /\b(?:inv-isess|job-inc|jfr|inv)-[\w.-]{8,}|\b(?:isess|evd|inc)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NOISE = /OOMKilled|docker\.inspect|docker\.stats|NanoCpus|RestartCount|不能代表|不能视为完整|不能据此判断|不能保证|truncated|pids=|throttl|堆健康|采集晚于/;
const RESOURCE = /JVM|OOM|CPU|内存|GC|throttl|限流|堆/;
const STEP_NOISE = /JVM|GC|OOM|throttl|docker\.stats|host\.memory|host\.load|补采|补查/;

export interface OnCallBrief {
  conclusion: string;
  evidence: string;
  unknown: string;
  steps: string[];
}

export function toOnCallBrief(hypothesis: string, recommendation: string, diagnosis?: InvestigationDiagnosis): OnCallBrief {
  if (diagnosis) return diagnosisBrief(diagnosis);
  const text = scrub(hypothesis);
  const sections = parseLabeled(text, ['结论', '依据', '未知', '已观测事实', '已观测', '较可能原因', '可能原因']);
  const facts = sections['已观测事实'] ?? sections['已观测'] ?? '';
  const cause = sections['较可能原因'] ?? sections['可能原因'] ?? '';
  const conclusion = sections['结论']
    ? cap(sections['结论'], 160)
    : facts || cause
      ? conclusionFrom(cause || facts, facts)
      : cap(text, 160) || '诊断没有写出结论。';
  const evidence = sections['结论']
    ? cap(sections['依据'] ?? '', 180)
    : evidenceFrom(facts);
  const unknown = unknownFrom(sections['未知'] ?? '', conclusion);
  return {
    conclusion: finish(conclusion),
    evidence: finish(evidence),
    unknown: unknown === '无' ? '' : finish(unknown),
    steps: pickSteps(recommendation.replace(POLICY_PREFIX, ''), conclusion).map(finish),
  };
}

function diagnosisBrief(diagnosis: InvestigationDiagnosis): OnCallBrief {
  const mitigation = diagnosis.actions.find((action) => action.purpose === 'mitigation');
  const repair = diagnosis.actions.find((action) => action.purpose === 'repair');
  const verification = diagnosis.actions.find((action) => action.purpose === 'verification');
  const check = diagnosis.actions.find((action) => action.purpose === 'evidence_collection');
  const steps = [
    ...(mitigation ? [renderAction(mitigation)] : []),
    ...(repair ? [renderAction(repair)] : ['修复尚未确定。', check ? renderAction(check) : '补证：对齐故障时间的日志、调用栈与有效配置，逐项核对候选原因的支持和反证，再决定修复。']),
    ...(verification ? [renderAction(verification)] : ['验证：检查同一服务的健康响应和关键业务请求，确认错误、延迟与超时是否恢复。']),
  ];
  return {
    conclusion: diagnosis.candidateCauses.map((item) => item.cause).join('\n'),
    evidence: diagnosis.observations.map((item) => item.statement).join('\n'),
    unknown: diagnosis.uncertainties.join('\n'),
    steps,
  };
}

function renderAction(action: InvestigationAction): string {
  const label = { mitigation: '止损', repair: '修复', verification: '验证', evidence_collection: '补证' }[action.purpose];
  return `${label}${action.requiresApproval ? '（需批准）' : ''}：${action.target}\n前提：${action.preconditions.join('；')}\n${action.operation}\n预期：${action.expectedResult}\n风险：${action.risk}`;
}

export function deterministicSteps(incident: NotificationPayload['incident'], recovered: boolean): string[] {
  const verify = `验证：检查 ${incident.service} 的健康响应和关键业务请求，对照错误率、超时与延迟确认可用性，不以进程存活代替业务恢复。`;
  if (recovered) return [verify];
  const window = `对齐故障时间 ${incident.firstSeen}`;
  let check: string;
  switch (incident.type) {
    case 'health.failure':
      check = `${window}，检查已配置健康 URL 的状态码和响应体，并核对应用日志；区分应用未响应与依赖组件异常。`;
      break;
    case 'jvm.oom':
    case 'container.oom':
    case 'jvm.gc_pressure':
      check = `${window}，核对异常类型、JVM -Xms/-Xmx 与容器内存限制，比较 GC 后堆占用和分配栈；区分堆保留与容器限额，不默认采集有暂停和磁盘风险的 heap dump。`;
      break;
    case 'jvm.cpu_pressure':
      check = `${window}，比较连续 docker.stats、cgroup cpu.stat 的 nr_throttled/throttled_usec 与 CPU 配额，再对照 JFR 热点和请求延迟；区分短时突发与持续受限。`;
      break;
    case 'business.error':
    case 'jvm.stack_overflow':
      check = `${window}，读取异常头、cause 链和业务栈对应源码行，关联请求入口与调用来源；区分本地抛错与下游失败，禁止直接重放有副作用的请求。`;
      break;
    case 'container.die':
    case 'container.restart':
      check = `${window}，检查退出码、重启记录、容器日志与部署操作；区分预期发布、进程崩溃和资源耗尽，不凭 exit 137 判断 OOM。`;
      break;
    case 'host.disk_pressure':
      check = `${window}，检查磁盘容量、inode 与增长目录；区分日志增长和业务数据增长，不直接删除数据。`;
      break;
    case 'host.memory_pressure':
      check = `${window}，比较可用内存、主要进程占用和容器限制；区分进程增长与缓存，不盲目清缓存。`;
      break;
    case 'application.slow_sql':
      check = `${window}，核对慢 SQL 耗时、锁等待与执行计划；区分阻塞和扫描量增长，不直接终止事务。`;
      break;
    default:
      check = `${window}，核对同一服务的异常日志、最近变更和请求结果，逐项验证候选原因，不凭告警名称修改配置。`;
  }
  return [
    '止损（需批准）：若故障仍持续且已确认影响业务，由负责人批准后隔离故障流量或暂停已确认的触发任务；先核对备用容量和回滚路径，避免扩大中断。',
    `修复尚未确定。${check}`,
    verify,
  ];
}

function conclusionFrom(cause: string, facts: string): string {
  const url = facts.match(/https?:\/\/[^\s，。；）)]+/)?.[0];
  const status = facts.match(/(?:code=|返回\s*|收到\s*)(\d{3})/)?.[1];
  const kept = keepClauses(cause);
  if (!kept) return status ? `直接原因未确认，已观测到返回 ${status}` : '直接原因未确认';
  if (url && status && /Feign|调用|下游|远程/i.test(`${cause} ${facts}`) && !kept.includes(url)) {
    const tail = /未知/.test(kept) ? '来源还不清楚。' : '';
    return cap(`下游 ${url} 返回 ${status}。${tail}`, 180);
  }
  const withStatus = status && !kept.includes(status) ? `${kept}。返回 ${status}` : kept;
  return cap(withStatus, 180);
}

function keepClauses(text: string): string {
  const parts = text.split(/[；。]/).flatMap((part) => part.split(/，(?=不能|不证明|不支持|需读|需核对|需确认|异常类不|异常文本只)/));
  return parts
    .map((item) => item.trim())
    .filter((item) => item && !/^(不能|不证明|不支持|需读|需核对|需确认|异常类不|异常文本只)/.test(item))
    .filter((item) => !/不能把|不证明|列为较可能/.test(item))
    .slice(0, 2)
    .join('。');
}

function evidenceFrom(facts: string): string {
  if (!facts) return '';
  const extracted = extractEvidence(facts);
  if (extracted) return cap(extracted, 180);
  const sentences = facts.split('。').map(cleanSentence).filter((item) => item.length > 8);
  const useful = sentences.filter((item) => !NOISE.test(item));
  return cap((useful.length > 0 ? useful : sentences).slice(0, 2).join('。'), 180);
}

function extractEvidence(facts: string): string {
  const url = facts.match(/https?:\/\/[^\s，。；）)]+/)?.[0];
  const path = facts.match(/\b(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/);
  const method = facts.match(/Method:\s*(GET|POST|PUT|DELETE|PATCH)/i)?.[1]?.toUpperCase();
  const exception = facts.match(/\b([A-Za-z]+(?:Exception|Error)(?:\$[A-Za-z]+)?)\b/)?.[1];
  const location = [...facts.matchAll(/([A-Z][A-Za-z0-9]+\.[A-Za-z0-9]+)\([A-Za-z0-9]+\.java:(\d+)\)/g)].at(-1);
  const body = facts.match(/请求体\s*([^\s，。；]+)/)?.[1] ?? facts.match(/Body:\s*(\{[^}]+\})/)?.[1];
  const status = facts.match(/(?:code=|返回\s*|收到\s*)(\d{3})/)?.[1];
  const target = /Feign/i.test(facts) && url
    ? `${method ?? ''} ${url}`.trim()
    : path
      ? `${path[1]} ${path[2]!.replace(/[，。；）)]+$/, '')}`
      : url;
  if (!target && !exception) return '';
  const head = [target, exception ? `异常 ${exception}` : '', location ? `位置 ${location[1]}:${location[2]}` : ''].filter(Boolean).join('，');
  const tail = [body ? `请求 ${body}` : '', status ? `返回 ${status}` : ''].filter(Boolean).join('，');
  const line = [head, tail].filter(Boolean).join('。');
  return line.length >= 12 ? line : '';
}

function unknownFrom(raw: string, conclusion: string): string {
  if (!raw) return '';
  const dropResource = !RESOURCE.test(conclusion);
  const kept = raw.split(/[；。、，]/)
    .map((item) => item.replace(/^以及/, '').trim())
    .filter((item) => item && !/不证明|只证明|不能说明|不能证明/.test(item))
    .filter((item) => !(dropResource && RESOURCE.test(item)));
  if (kept.length === 0) return cap(cleanSentence(raw.split(/[；。]/)[0] ?? ''), 100);
  return cap(kept.join('、'), 100);
}

function pickSteps(recommendation: string, conclusion: string): string[] {
  const lines = recommendation
    .replace(/\s+(?=\d+[).、])/g, '\n')
    .split(/\n+/)
    .map((line) => scrub(line).replace(/^\d+[).、]\s*/, '').trim())
    .filter((line) => line.length > 0 && !isFiller(line));
  const specific = RESOURCE.test(conclusion) ? lines : lines.filter((line) => !STEP_NOISE.test(line));
  return (specific.length > 0 ? specific : lines).slice(0, 3).map((line) => cap(line, 140));
}

function parseLabeled(text: string, labels: string[]): Record<string, string> {
  const found = labels
    .map((label) => ({ label, at: labelAt(text, label) }))
    .filter((item) => item.at >= 0)
    .sort((left, right) => left.at - right.at);
  const sections: Record<string, string> = {};
  for (let i = 0; i < found.length; i++) {
    const start = found[i]!.at + found[i]!.label.length + 1;
    const end = found[i + 1]?.at ?? text.length;
    sections[found[i]!.label] = text.slice(start, end).replace(/^[：:]/, '').trim();
  }
  return sections;
}

function labelAt(text: string, label: string): number {
  for (const colon of ['：', ':']) {
    const token = `${label}${colon}`;
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(token, from);
      if (at < 0) break;
      if (!(label === '已观测' && text.startsWith('已观测事实', at))
        && !(label === '可能原因' && text[at - 1] === '较')) return at;
      from = at + token.length;
    }
  }
  return -1;
}

function scrub(text: string): string {
  return text
    .replace(ID_TOKEN, '')
    .replace(/(?:[a-z][a-z0-9_]*\.){2,}([A-Z][A-Za-z0-9_]+)/g, '$1')
    .replace(/[（(]\s*[、,，\s]*[）)]/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([，。；])\s*/g, '$1')
    .replace(/[，、]{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/。的/g, '。')
    .replace(/在时间窗/g, '')
    .replace(/拉取前后/g, '拉取事件前后')
    .trim();
}

function finish(text: string): string {
  if (!text || /[。…]$/.test(text)) return text;
  return `${text}。`;
}

function cleanSentence(text: string): string {
  return text.replace(/^[的\s]+/, '').trim();
}

function cap(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').replace(/^[，。；、\s]+|[，。；、\s]+$/g, '').trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const at = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('，'), slice.lastIndexOf('；'));
  const cut = at >= Math.floor(max * 0.6) ? slice.slice(0, at) : slice.trimEnd();
  return `${cut}…`;
}

function isFiller(line: string): boolean {
  const compact = line.replace(/\s/g, '');
  if (compact.length < 40) return false;
  const counts = new Map<string, number>();
  for (const ch of compact) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return Math.max(...counts.values()) / compact.length > 0.8;
}
