/**
 * Did the diagnosis give a real repair, or only say "repair not determined"?
 *
 * A real repair must cite a source.snippet evidence id AND name a fact that
 * only the snippet carries. Facts already visible in the other evidence (the
 * stack frame, the log line) do not make a repair source-based.
 */

export type RepairKind = 'real_repair' | 'undetermined' | 'fallback';

export interface RepairSnippet {
  id: string;
  kind: string;
  text: string;
}

interface RepairAction {
  purpose?: string;
  operation?: string;
  evidenceIds?: readonly string[];
}

export interface RepairDiagnosis {
  hypothesis?: string;
  recommendation?: string;
  uncertainties?: readonly string[];
  actions?: readonly RepairAction[];
  summary?: { recovery?: readonly string[] };
}

const TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
const GENERIC = new Set([
  'public', 'private', 'protected', 'static', 'final', 'class', 'interface', 'void', 'int',
  'long', 'short', 'byte', 'char', 'double', 'float', 'boolean', 'string', 'true', 'false',
  'null', 'this', 'return', 'throw', 'throws', 'new', 'else', 'while', 'catch', 'try', 'for',
  'super', 'extends', 'implements', 'package', 'import', 'record', 'enum', 'abstract',
  'synchronized', 'native', 'transient', 'volatile', 'instanceof', 'name', 'value', 'prefix',
  'enabled', 'disabled', 'run', 'index', 'line', 'file', 'code', 'text', 'data', 'type',
  'get', 'set', 'add', 'size', 'length',
]);
const UNDETERMINED = /修复(?:方案|办法|方向|动作)?(?:尚未确定|未确定|未知|待确认|待核实)/;

/** Identifiers the snippet carries that no other current evidence carries. */
export function snippetOnlyFacts(snippetText: string, otherEvidenceText: string): Set<string> {
  const other = otherEvidenceText.toLowerCase();
  const facts = new Set<string>();
  for (const match of snippetText.matchAll(TOKEN)) {
    const token = match[0];
    if (token.length < 4 || GENERIC.has(token.toLowerCase())) continue;
    if (other.includes(token.toLowerCase())) continue;
    facts.add(token);
  }
  return facts;
}

export function classifyRepair(
  diagnosis: RepairDiagnosis | undefined,
  options: { snippets: readonly RepairSnippet[]; otherEvidenceText: string },
): RepairKind {
  const snippets = options.snippets.filter((item) => item.kind === 'source.snippet');
  for (const action of diagnosis?.actions ?? []) {
    if (action.purpose !== 'repair') continue;
    const operation = action.operation ?? '';
    if (UNDETERMINED.test(operation)) continue;
    if (snippets.some((item) => (action.evidenceIds ?? []).includes(item.id)
      && [...snippetOnlyFacts(item.text, options.otherEvidenceText)].some((fact) => operation.includes(fact)))) return 'real_repair';
  }
  const text = [
    diagnosis?.hypothesis, diagnosis?.recommendation,
    ...(diagnosis?.uncertainties ?? []), ...(diagnosis?.summary?.recovery ?? []),
    ...(diagnosis?.actions ?? []).map((action) => action.operation),
  ].join('\n');
  return UNDETERMINED.test(text) ? 'undetermined' : 'fallback';
}
