import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { decodeDockerLogs, fetchDockerLogs } from '../evidence/docker.js';
import { scanContainerLog } from '../events/log-events.js';
import { makeNodeAgentConfig } from './test-config.js';
const SOURCE = { container: 'log-drill', nodeId: 'local-dev', service: 'log-drill' };
const stamped = (lines: string[]) => lines.map((line) => `2026-10-26T19:30:01.123456789Z ${line}`);
function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

it('requests timestamps and one extra tail line so Engine truncation is detectable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-contract-'));
  const socket = join(dir, 'docker.sock');
  let query = '';
  const server = createServer((req, res) => { query = req.url ?? ''; res.end(); });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await fetchDockerLogs(makeNodeAgentConfig({ dockerSocketPath: socket }), 'workload', { maxLines: 2000 }, 10000);
    const params = new URL(query, 'http://docker').searchParams;
    assert.equal(params.get('timestamps'), '1');
    assert.equal(params.get('tail'), '2001');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reassembles partial UTF-8 and partial lines within each stream', () => {
  const text = Buffer.from('2026-10-26T19:30:01.123456789Z ERROR 失败\n');
  const split = text.length - 5;
  function bytes(payload: Buffer) {
    const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }
  const decoded = decodeDockerLogs(Buffer.concat([bytes(text.subarray(0, split)), frame(2, 'other\n'), bytes(text.subarray(split))]), 10000, 200);
  assert.equal(decoded.records.find((record) => record.stream === 'stdout')!.body, 'ERROR 失败');
});

it('never treats a byte-truncated Python terminal as confirmed fatal evidence', () => {
  const text = stamped(['Traceback (most recent call last):', '  File "x.py", line 1, in run', 'MemoryError: truncated message']).join('\n');
  const decoded = decodeDockerLogs(Buffer.from(text), Buffer.byteLength(text) - 10, 200, true);
  assert.deepEqual(scanContainerLog(decoded.records, SOURCE, false), []);
});

it('does not promote a quoted Node error or an ordinary sentence mentioning it to fatal', () => {
  for (const text of ['docs: "RangeError: Maximum call stack size exceeded"', 'A guide mentions RangeError: Maximum call stack size exceeded', '2026-10-27 03:30:01 INFO RangeError: Maximum call stack size exceeded']) {
    assert.deepEqual(scanContainerLog(stamped([text]), SOURCE, false), []);
  }
});
