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
const LIBRARY_CLASS = /^(?:java|javax|jakarta|jdk|sun|com\.sun|org\.springframework|org\.apache|org\.hibernate|io\.netty|com\.fasterxml|com\.zaxxer|org\.junit|com\.mysql|com\.baomidou|com\.alibaba|okhttp3|feign|io\.lettuce|redis\.clients|org\.mybatis)\./;
const FILE_NAME = /^[\w$.-]+\.java$/;
const SKIP_DIRECTORIES = new Set(['.git', '.gradle', '.idea', 'build', 'dist', 'node_modules', 'out', 'target']);
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 12;
const MAX_FILE_BYTES = 1024 * 1024;
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*)[^\r\n]*/gi;

export function buildSourceSnippet(input: SourceSnippetInput): SourceSnippet | undefined {
  const frames = applicationFrames(input.evidence);
  const first = frames[0];
  if (!first) return undefined;
  let frame = first;
  const baseFor = (current: StackFrame) => ({
    service: input.incident.service,
    className: current.className,
    method: current.method,
    file: current.file,
    stackLine: current.line,
  });
  const missing = (versionNote: string): SourceSnippet => ({
    ...baseFor(frame), startLine: 0, endLine: 0, versionStatus: 'missing', versionNote, text: '',
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
  const found = findFiles(realRoot, new Set(frames.map((item) => item.file)));
  if (found.incomplete) return missing('源码目录搜索不完整，无法排除同名文件。');
  const matched = frames.find((item) => found.paths.has(item.file) || found.escaped.has(item.file));
  if (!matched) return missing(`源码根目录下没有 ${frame.file} 等栈帧对应的文件。`);
  frame = matched;
  if (found.escaped.has(frame.file)) return undefined;
  const paths = found.paths.get(frame.file)!;
  if (paths.length > 1) {
    return missing(`源码根目录下有 ${paths.length} 个同名文件 ${frame.file}，无法确定是哪一个。`);
  }
  const absolute = paths[0]!;
  let source: string;
  try {
    if (statSync(absolute).size > MAX_FILE_BYTES) return missing('源码文件过大，未读取');
    source = readFileSync(absolute, 'utf8');
  } catch {
    return missing(`读取 ${frame.file} 失败。`);
  }
  const lines = redactAssignments(source).split('\n');
  const window = readWindow(lines, frame);
  return {
    ...baseFor(frame),
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

function applicationFrames(evidence: SourceSnippetInput['evidence']): StackFrame[] {
  const frames: StackFrame[] = [];
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
        frames.push({ className, method, file, line });
      }
    }
  }
  return frames;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output);
}

function findFiles(realRoot: string, fileNames: ReadonlySet<string>): {
  paths: Map<string, string[]>; escaped: Set<string>; incomplete: boolean;
} {
  const paths = new Map<string, string[]>();
  const escaped = new Set<string>();
  let incomplete = false;
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
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
      if (!fileNames.has(entry.name)) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let real: string;
      try {
        real = realpathSync(absolute);
        if (!statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      if (!inside(realRoot, real)) {
        escaped.add(entry.name);
        continue;
      }
      const matches = paths.get(entry.name) ?? [];
      if (matches.length < 2) matches.push(real);
      paths.set(entry.name, matches);
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
  const code = javaCode(lines.join('\n')).split('\n');
  let declaration = -1;
  if (!outOfRange) {
    const from = Math.max(0, anchor - 80);
    const to = Math.min(lines.length, anchor + 81);
    const pattern = methodDeclarationPattern(frame.method);
    for (let index = from; index < to; index += 1) {
      if (!pattern.test(code[index] ?? '')) continue;
      if (methodOpening(code, index) === undefined) continue;
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
  const bodyEnd = methodEnd(code, declaration);
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
  return new RegExp(`^(?!.*\\b(?:return|throw|new)\\b)\\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\\s+)*(?:[\\w$<>?,.\\[\\]]+\\s+)+${escapeRegExp(method)}\\s*\\(`);
}

function methodPattern(method: string): RegExp {
  return new RegExp(`(?:^|[^\\w$])${escapeRegExp(method)}\\s*\\(`);
}

function methodOpening(lines: string[], declaration: number): { line: number; column: number } | undefined {
  let depth = 0;
  let started = false;
  for (let line = declaration; line < Math.min(lines.length, declaration + 81); line += 1) {
    for (let column = 0; column < lines[line]!.length; column += 1) {
      const char = lines[line]![column];
      if (char === '(') { depth += 1; started = true; }
      if (char === ')') depth -= 1;
      if (started && depth === 0 && char === ';') return undefined;
      if (started && depth === 0 && char === '{') return { line, column };
    }
  }
  return undefined;
}

function methodEnd(lines: string[], declaration: number): number {
  const opening = methodOpening(lines, declaration);
  if (!opening) return declaration;
  let depth = 0;
  for (let line = opening.line; line < Math.min(lines.length, declaration + MAX_LINES); line += 1) {
    for (let column = line === opening.line ? opening.column : 0; column < lines[line]!.length; column += 1) {
      const char = lines[line]![column];
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) return line;
    }
  }
  return Math.min(lines.length - 1, declaration + MAX_LINES - 1);
}

function javaCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (value) => value.replace(/[^\n]/g, ' '));
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
  return text
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*)"""([\s\S]*?)"""/gi,
      (_match, prefix: string, body: string) => `${prefix}[redacted]${'\n'.repeat(body.split('\n').length - 1)}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']*:)[^\s@"']*(@)/gi, '$1[redacted]$2')
    .replace(/(\bBearer\s+)[^\s"',;)]+/gi, '$1[redacted]')
    .replace(/(\bAuthorization["']?\s*[:,=]\s*["']?)(?:Basic\s+|Bearer\s+)?[^"'\r\n,)]+/gi, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
