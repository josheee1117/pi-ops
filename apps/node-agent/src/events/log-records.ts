import { createHash } from 'node:crypto';
import type { OpsEvent } from '@pi-ops/protocol';
import type { DockerLogRecord } from '../evidence/docker.js';
import type { LogScanSource } from './log-events.js';

const TRACEBACK = 'Traceback (most recent call last):';
const CHAIN = /^(?:During handling of the above exception|The above exception was the direct cause)/;
const FRAME = /^\s+at\s/;
const NATIVE_FRAME = /^\s*\d+:\s+0x[\da-f]+\b/i;
const PYTHON_END = /^([\w.]+)(?::\s*(.*))?$/;
const JAVA_HEAD = /^\s*((?:[\w$]+\.)+[\w$]*(?:Exception|Error))\b(?::\s*(.*))?/;
const JAVA_FATAL = /\b(java\.lang\.(?:OutOfMemoryError|StackOverflowError))\b(?::\s*(.*))?/;
const NODE_HEAD = /(?:^|\s)([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/;

export function logTemplate(message: string): string {
  return message
    .replace(/"(?:\\.|[^"\\])*"|(?<=^|[\s([{:;,=])'(?:\\.|[^'\\])*'/g, '<quoted>')
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b(?:0x[\da-f]+|[\da-f]{16,})\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>');
}

function errorLine(body: string): { message: string; module: string } | undefined {
  if (body.trimStart().startsWith('{')) {
    try {
      const json: unknown = JSON.parse(body);
      if (!json || typeof json !== 'object' || !('level' in json) || json.level !== 'error') return undefined;
      const message = 'msg' in json && typeof json.msg === 'string' ? json.msg
        : 'message' in json && typeof json.message === 'string' ? json.message : body;
      const logger = 'name' in json && typeof json.name === 'string' && /^[\w]+(?:\.[\w]+)+$/.test(json.name) ? json.name : '';
      return { message, module: [logger, logTemplate(message)].filter(Boolean).join(':') };
    } catch { return undefined; }
  }
  const match = /^(?:(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.,Z:+-]*\s+)|(?:\[[^\]]+\]\s+))?\[?ERROR\]?\s+(.*)$/i.exec(body);
  if (!match) return undefined;
  const rest = match[1] ?? '';
  const fields = /^(\S+)\s+(.*)$/.exec(rest);
  const first = fields?.[1] ?? '';
  const isLogger = /^[\w]+(?:\.[\w]+)+$/.test(first) && !/^[\d.]+$/.test(first);
  const message = fields && (isLogger || /^\d+$/.test(first)) ? fields[2] ?? '' : rest;
  return { message, module: [isLogger ? first : '', logTemplate(message)].filter(Boolean).join(':') };
}

function nodeHead(body: string): RegExpExecArray | null {
  if (body.trimStart().startsWith('{') || /^(?:INFO|WARN(?:ING)?|DEBUG|TRACE)\b/.test(body)) return null;
  const match = NODE_HEAD.exec(body);
  if (!match) return null;
  const before = body.slice(0, match.index).trimEnd();
  if (/["']$/.test(before) || /["']/.test(match[1] ?? '')) return null;
  return match;
}

function fatalPython(clazz: string, message: string): string | undefined {
  if (clazz === 'MemoryError') return 'runtime.oom';
  if (clazz === 'RecursionError' && message.startsWith('maximum recursion depth exceeded')) return 'runtime.stack_overflow';
  return undefined;
}

export interface RawScanResult {
  events: OpsEvent[];
  pending: DockerLogRecord[];
  unfinishedDropped: number;
}

/** Recognition owns complete records before standalone ERROR lines get a turn. */
export function scanRawRecords(
  records: readonly DockerLogRecord[],
  source: LogScanSource,
  instrumented: boolean,
  fatalFromPayload: ReadonlySet<string>,
  deferIncomplete = false,
  settledRecords: ReadonlySet<DockerLogRecord> = new Set(),
): RawScanResult {
  const result: RawScanResult = { events: [], pending: [], unfinishedDropped: 0 };
  for (const stream of ['stdout', 'stderr'] as const) {
    const lines = records.filter((record) => record.stream === stream);
    const claimed = new Set<number>();
    let fallbackTime: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const record = lines[index]!;
      if (record.time) fallbackTime = record.time;
      else {
        const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(record.body);
        if (match) fallbackTime = `${match[1]}T${match[2]}Z`;
      }
      if (claimed.has(index) || record.body.includes('[PI_OPS_JFR] ')) { claimed.add(index); continue; }
      const body = record.body;
      const javaFatal = JAVA_FATAL.exec(body);
      const java = JAVA_HEAD.exec(body) ?? (javaFatal && !body.trimStart().startsWith('{')
        && !/["']/.test(body[javaFatal.index - 1] ?? '')
        && (/^Exception in thread "[^"]+"\s+$/.test(body.slice(0, javaFatal.index)) || FRAME.test(lines[index + 1]?.body ?? '')) ? javaFatal : null);
      const node = nodeHead(body);
      const native = /^FATAL ERROR:.*JavaScript heap out of memory/.test(body);
      const python = body === TRACEBACK;
      if (!python && !java && !node && !native) continue;

      let start = index;
      let previous = index - 1;
      while (previous >= 0 && !lines[previous]!.body.trim()) previous -= 1;
      if (previous >= 0 && !claimed.has(previous) && errorLine(lines[previous]!.body)) start = previous;
      let end = index + 1;
      let clazz = java?.[1] ?? node?.[1] ?? (native ? 'Error' : '');
      let message = java?.[2] ?? node?.[2] ?? (native ? body.slice('FATAL ERROR:'.length).trim() : '');
      let fatal: string | undefined = native ? 'runtime.oom'
        : clazz === 'java.lang.OutOfMemoryError' ? 'jvm.oom'
        : clazz === 'java.lang.StackOverflowError' ? 'jvm.stack_overflow'
        : clazz === 'RangeError' && message === 'Maximum call stack size exceeded' && (body.startsWith('RangeError:') || FRAME.test(lines[end]?.body ?? '')) ? 'runtime.stack_overflow' : undefined;
      let firstException: { clazz: string; message: string } | undefined;
      let complete = Boolean(fatal && !python);
      if (python) {
        complete = false;
        let awaitingTraceback = false;
        while (end < lines.length) {
          const next = lines[end]!;
          const text = next.body;
          if (next.partial) break;
          if (!text.trim()) { end += 1; continue; }
          if (CHAIN.test(text)) { awaitingTraceback = true; complete = false; end += 1; continue; }
          if (text === TRACEBACK && awaitingTraceback) { awaitingTraceback = false; end += 1; continue; }
          if (/^\s/.test(text) && !complete && !awaitingTraceback) { end += 1; continue; }
          const terminal = PYTHON_END.exec(text);
          if (!complete && !awaitingTraceback && terminal) {
            clazz = terminal[1]!;
            message = terminal[2] ?? '';
            firstException ??= { clazz, message };
            fatal ??= fatalPython(clazz, message);
            complete = true;
            end += 1;
            continue;
          }
          break;
        }
      } else {
        while (end < lines.length && (FRAME.test(lines[end]!.body) || (native && NATIVE_FRAME.test(lines[end]!.body)))) end += 1;
        complete ||= end > index + 1;
      }
      const block = lines.slice(start, end);
      const overLimit = block.length > 200 || Buffer.byteLength(block.map((item) => item.line).join('\n')) > 65536;
      for (let owned = start; owned < end; owned += 1) claimed.add(owned);
      if (!complete || record.partial) {
        if (deferIncomplete && end === lines.length && !overLimit) result.pending.push(...block);
        else result.unfinishedDropped += 1;
        index = end - 1;
        continue;
      }
      if (overLimit && python) { result.unfinishedDropped += 1; index = end - 1; continue; }
      // A terminal at the poll boundary may still be followed by a chained traceback.
      if (python && deferIncomplete && end === lines.length && !settledRecords.has(lines[end - 1]!)) {
        result.pending.push(...block);
        index = end - 1;
        continue;
      }
      const type = fatal ?? 'business.error';
      const isJava = Boolean(java);
      if ((instrumented && !fatal) || (isJava && fatalFromPayload.has(clazz))) { index = end - 1; continue; }
      const time = lines[start]!.time ?? fallbackTime ?? new Date().toISOString();
      const stack = isJava && !record.time
        ? lines.slice(index + 1, end).map((item) => item.body.trim()).join('\n')
        : block.map((item) => item.body).join('\n');
      const attributes: OpsEvent['attributes'] = {
        containerName: source.container, observedVia: 'docker.logs', module: clazz,
        exceptionClass: clazz, exceptionMessage: message, stackTrace: stack, logRecordCount: 1,
      };
      if (firstException && firstException.clazz !== clazz) {
        attributes['outerExceptionClass'] = firstException.clazz;
        attributes['outerExceptionMessage'] = firstException.message;
      }
      if (fatal?.startsWith('runtime.')) attributes['runtime'] = python ? 'python' : 'node';
      if (native && end === index + 1) attributes['stackIncomplete'] = true;
      if (!fatal) {
        attributes['businessCode'] = 'UNHANDLED_EXCEPTION';
        if (!isJava) attributes['logEpisode'] = true;
      }
      result.events.push(makeEvent(type, time, clazz, `${clazz}: ${message}`, attributes, source));
      index = end - 1;
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (claimed.has(index)) continue;
      const record = lines[index]!;
      const error = errorLine(record.body);
      if (!error || record.partial) continue;
      if (deferIncomplete && index === lines.length - 1 && !settledRecords.has(record)) {
        result.pending.push(record);
        continue;
      }
      result.events.push(makeEvent('business.error', record.time ?? new Date().toISOString(), error.module, error.message, {
        containerName: source.container, observedVia: 'docker.logs', businessCode: 'LOG_ERROR',
        module: error.module, stackTrace: record.body, logEpisode: true, logRecordCount: 1,
      }, source));
    }
  }
  return result;
}

function makeEvent(type: string, time: string, key: string, message: string, attributes: OpsEvent['attributes'], source: LogScanSource): OpsEvent {
  return {
    schemaVersion: 1,
    id: createHash('sha256').update(JSON.stringify(['docker.logs', source.nodeId, source.container, type, key, time])).digest('hex'),
    time, source: 'docker', nodeId: source.nodeId, service: source.service,
    type, severity: type === 'business.error' ? 'error' : 'critical', message: message.slice(0, 512), attributes,
  };
}

export function coalesceLogEvents(events: readonly OpsEvent[]): OpsEvent[] {
  const grouped = new Map<string, OpsEvent>();
  for (const event of events) {
    const key = event.source === 'application' ? event.id
      : JSON.stringify([event.type, event.attributes['module'], logTemplate(String(event.attributes['exceptionMessage'] ?? event.message))]);
    const previous = grouped.get(key);
    if (previous) previous.attributes['logRecordCount'] = Number(previous.attributes['logRecordCount']) + Number(event.attributes['logRecordCount']);
    else grouped.set(key, { ...event, attributes: { ...event.attributes } });
  }
  return [...grouped.values()];
}
