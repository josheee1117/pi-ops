import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, sep, join } from 'node:path';
import type { SourceRoots } from './source-roots.js';
import type { EvidenceRecord, IncidentRow } from './store.js';

export const SOURCE_SNIPPET_KIND = 'source.snippet';

export type SourceVersionStatus = 'missing' | 'drifted' | 'unchecked' | 'matched';

export interface SourceSnippet {
  service: string;
  className: string;
  method: string;
  /** Repository-relative path inside the configured root, never absolute. */
  file: string;
  stackLine: number;
  startLine: number;
  endLine: number;
  versionStatus: SourceVersionStatus;
  versionNote: string;
  /** Only enters the investigation context; never detail markdown or raw evidence. */
  text: string;
}

export interface SourceSnippetInput {
  incident: Pick<IncidentRow, 'id' | 'service' | 'node_id'>;
  evidence: ReadonlyArray<Pick<EvidenceRecord, 'kind' | 'data'>>;
  roots: SourceRoots;
}

interface StackFrame {
  className: string;
  method: string;
  file: string;
  line: number;
}

const MAX_LINES = 40;
const MAX_CHARS = 1500;
const MAX_MINOR_LINES = 20;
/** Matches `at pkg.Class.method(File.java:12)`, including mojibake-prefixed log lines. */
const STACK_FRAME = /\bat\s+([\w$.]+)\.([\w$<>]+)\(([^()\s]+\.java):(\d+)\)/g;
const LIBRARY_CLASS = /^(?:java|javax|jakarta|jdk|sun|com\.sun|org\.springframework|org\.apache|org\.hibernate|io\.netty|com\.fasterxml|com\.zaxxer|org\.junit)\./;
const FILE_NAME = /^[\w$.-]+\.java$/;
const SKIP_DIRECTORIES = new Set(['.git', '.gradle', '.idea', 'build', 'dist', 'node_modules', 'out', 'target']);
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 12;
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*)[^\r\n]*/gi;

export function buildSourceSnippet(input: SourceSnippetInput): SourceSnippet | undefined {
  const frame = firstApplicationFrame(input.evidence);
  if (!frame) return undefined;
  const base = {
    service: input.incident.service,
    className: frame.className,
    method: frame.method,
    file: frame.file,
    stackLine: frame.line,
  };
  const missing = (versionNote: string, file = frame.file): SourceSnippet => ({
    ...base, file, startLine: 0, endLine: 0, versionStatus: 'missing', versionNote, text: '',
  });

  const root = input.roots[input.incident.service];
  if (!root) {
    return missing(`服务 ${input.incident.service} 未配置源码根目录，未读取源码。`);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return missing(`服务 ${input.incident.service} 的源码根目录不可读，未读取源码。`);
  }
  const found = findFiles(realRoot, frame.file);
  if (found.incomplete) return missing('源码目录搜索不完整，无法排除同名文件。');
  if (found.escaped) return undefined;
  if (found.paths.length === 0) return missing(`源码根目录下没有 ${frame.file}。`);
  if (found.paths.length > 1) {
    return missing(`源码根目录下有 ${found.paths.length} 个同名文件 ${frame.file}，无法确定是哪一个。`);
  }
  const absolute = found.paths[0]!;
  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    return missing(`读取 ${frame.file} 失败。`);
  }
  const lines = redactAssignments(source).split('\n');
  const window = readWindow(lines, frame);
  return {
    ...base,
    file: relative(realRoot, absolute).split(sep).join('/'),
    startLine: window.startLine,
    endLine: window.endLine,
    versionStatus: window.drifted ? 'drifted' : 'unchecked',
    versionNote: window.drifted
      ? driftNote(frame, lines)
      : '版本未核对：没有可核对的运行版本信息。',
    text: window.text,
  };
}

export function sourceSnippetEvidence(input: SourceSnippetInput & { collectedAt: string }): EvidenceRecord | undefined {
  const snippet = buildSourceSnippet(input);
  if (!snippet) return undefined;
  const digest = createHash('sha256')
    .update([
      input.incident.id, snippet.className, snippet.method, String(snippet.stackLine),
    ].join('|'))
    .digest('hex')
    .slice(0, 32);
  return {
    id: `source-${digest}`,
    incidentId: input.incident.id,
    nodeId: input.incident.node_id,
    source: 'agent',
    kind: SOURCE_SNIPPET_KIND,
    collectedAt: input.collectedAt,
    status: 'succeeded',
    data: snippet,
  };
}

function firstApplicationFrame(evidence: SourceSnippetInput['evidence']): StackFrame | undefined {
  for (const item of evidence) {
    if (item.kind === SOURCE_SNIPPET_KIND) continue;
    const strings: string[] = [];
    collectStrings(item.data, strings);
    for (const value of strings) {
      STACK_FRAME.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STACK_FRAME.exec(value))) {
        const className = match[1]!;
        const method = match[2]!;
        const file = match[3]!;
        const line = Number(match[4]);
        if (className.includes('/') || LIBRARY_CLASS.test(className)) continue;
        if (!FILE_NAME.test(file) || file.includes('..')) continue;
        if (!Number.isSafeInteger(line) || line < 1) continue;
        return { className, method, file, line };
      }
    }
  }
  return undefined;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output);
}

function findFiles(realRoot: string, fileName: string): { paths: string[]; escaped: boolean; incomplete: boolean } {
  const paths: string[] = [];
  let escaped = false;
  let incomplete = false;
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    if (paths.length > 1) return;
    if (visited >= MAX_WALK_ENTRIES || depth > MAX_WALK_DEPTH) {
      incomplete = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      incomplete = true;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (paths.length > 1) return;
      if (visited >= MAX_WALK_ENTRIES) {
        incomplete = true;
        return;
      }
      visited += 1;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(absolute, depth + 1);
        continue;
      }
      if (entry.name !== fileName) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let real: string;
      try {
        real = realpathSync(absolute);
        if (!statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      if (!inside(realRoot, real)) {
        escaped = true;
        continue;
      }
      paths.push(real);
    }
  };
  walk(realRoot, 0);
  return { paths, escaped, incomplete };
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function readWindow(
  lines: string[],
  frame: StackFrame,
): { startLine: number; endLine: number; text: string; drifted: boolean } {
  const outOfRange = frame.line > lines.length;
  const anchor = Math.max(0, Math.min(frame.line - 1, lines.length - 1));
  let declaration = -1;
  if (!outOfRange) {
    const from = Math.max(0, anchor - 80);
    const to = Math.min(lines.length, anchor + 81);
    const pattern = methodDeclarationPattern(frame.method);
    for (let index = from; index < to; index += 1) {
      if (!pattern.test(lines[index] ?? '')) continue;
      if (declaration < 0 || Math.abs(index - anchor) < Math.abs(declaration - anchor)) declaration = index;
    }
  }
  if (declaration < 0) {
    const start = Math.max(0, anchor - MAX_MINOR_LINES);
    const text = capLines(lines.slice(start, start + MAX_LINES));
    return {
      startLine: start + 1,
      endLine: start + text.split('\n').length,
      text,
      drifted: true,
    };
  }
  const bodyEnd = methodEnd(lines, declaration);
  const header = classHeaderStart(lines, frame.className, declaration);
  let start = declaration;
  let end = bodyEnd;
  if (header !== undefined && bodyEnd - header + 1 <= MAX_LINES) start = header;
  if (end - start + 1 > MAX_LINES) end = start + MAX_LINES - 1;
  const window = lines.slice(start, end + 1);
  const text = capLines(window);
  return {
    startLine: start + 1,
    endLine: start + text.split('\n').length,
    text,
    drifted: outOfRange || !methodPattern(frame.method).test(text),
  };
}

function methodDeclarationPattern(method: string): RegExp {
  return new RegExp(`^(?!.*\\b(?:return|throw|new)\\b)\\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\\s+)*(?:[\\w$<>?,.\\[\\]]+\\s+)+${escapeRegExp(method)}\\s*\\([^;]*\\)\\s*(?:throws\\s+[\\w$.,\\s]+)?(?:\\{|$)`);
}

function methodPattern(method: string): RegExp {
  return new RegExp(`(?:^|[^\\w$])${escapeRegExp(method)}\\s*\\(`);
}

function methodEnd(lines: string[], declaration: number): number {
  let opening = -1;
  for (let index = declaration; index < Math.min(lines.length, declaration + 6); index += 1) {
    if (lines[index]?.includes('{')) {
      opening = index;
      break;
    }
  }
  if (opening < 0) return declaration;
  let depth = 0;
  for (let index = opening; index < Math.min(lines.length, declaration + MAX_LINES); index += 1) {
    depth += braceDelta(lines[index] ?? '');
    if (depth <= 0 && index > opening) return index;
  }
  return Math.min(lines.length - 1, declaration + MAX_LINES - 1);
}

function braceDelta(line: string): number {
  let delta = 0;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '/' && line[index + 1] === '/') break;
    if (character === '{') delta += 1;
    else if (character === '}') delta -= 1;
  }
  return delta;
}

/** Include the class-level annotations (`@Profile`, `@ConditionalOnProperty`) when they fit the window. */
function classHeaderStart(lines: string[], className: string, declaration: number): number | undefined {
  const simple = className.slice(className.lastIndexOf('.') + 1).split('$')[0]!;
  const pattern = new RegExp(`\\b(?:class|interface|enum|record)\\s+${escapeRegExp(simple)}\\b`);
  for (let index = declaration - 1; index >= Math.max(0, declaration - 80); index -= 1) {
    if (!pattern.test(lines[index] ?? '')) continue;
    let start = index;
    while (start > 0 && (lines[start - 1] ?? '').trim().startsWith('@')) start -= 1;
    return start;
  }
  return undefined;
}

function capLines(lines: string[]): string {
  const kept: string[] = [];
  let characters = 0;
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break;
    if (characters + line.length + 1 > MAX_CHARS) {
      if (kept.length === 0) kept.push(line.slice(0, MAX_CHARS));
      break;
    }
    kept.push(line);
    characters += line.length + 1;
  }
  return kept.join('\n');
}

function driftNote(frame: StackFrame, lines: string[]): string {
  if (frame.line > lines.length) {
    return `栈行号 ${frame.line} 超出 ${frame.file}（共 ${lines.length} 行），行号未经核对。`;
  }
  return `${frame.file} 第 ${frame.line} 行附近没有找到方法 ${frame.method}，行号未经核对。`;
}

function redactAssignments(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, '$1[redacted]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
