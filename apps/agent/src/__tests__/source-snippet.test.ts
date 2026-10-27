import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../app.js';
import { buildIncidentContext, selectEvidenceForContext } from '../incident-context.js';
import { incidentBrief, renderIncidentBrief } from '../incident-brief.js';
import { createIncidentEngine } from '../incident.js';
import { buildNotificationPayload, incidentFactsFromRow } from '../notification.js';
import { formatWeComMarkdown } from '../notifier.js';
import { loadSourceRoots } from '../source-roots.js';
import { buildSourceSnippet, sourceSnippetEvidence } from '../source-snippet.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';
import { makeAgentConfig } from './test-config.js';

const DATAASSET_FIXTURE = fileURLToPath(new URL(
  '../../../pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java',
  import.meta.url,
));
const DATAASSET_ROOT = dirname(DATAASSET_FIXTURE);
const SERVICE = 'rdl-dataasset-6dfb8e88';
const AT = '2026-10-14T03:40:12.880Z';
const DATAASSET_STACK = [
  'at com.mbkj.dap.lab.LabFaultController.serverFault(LabFaultController.java:25)',
  'at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
  'at org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:205)',
].join('\n');

function incident(service = SERVICE): IncidentRow {
  return {
    id: 'inc-source-1', service, node_id: 'node-1', type: 'business.error', state: 'OPEN',
    fingerprint: 'f', first_seen: AT, last_seen: AT, event_count: 1, severity: 'error',
  };
}

function stackEvidence(stack: string): Pick<EvidenceRecord, 'kind' | 'data'> {
  return {
    kind: 'jfr.signal',
    data: { eventType: 'business.error', attributes: { exceptionStackTrace: stack } },
  };
}

function snippet(roots: Record<string, string>, stack = DATAASSET_STACK, service = SERVICE) {
  return buildSourceSnippet({ incident: incident(service), evidence: [stackEvidence(stack)], roots });
}

const tempRoots: string[] = [];
after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

function tempRoot(action: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'source-root-'));
  tempRoots.push(root);
  action(root);
  return root;
}

it('reads the throwing method and its class config from the real DataAsset fixture', () => {
  const data = snippet({ [SERVICE]: DATAASSET_ROOT });
  assert.ok(data);
  assert.equal(data.service, SERVICE);
  assert.equal(data.className, 'com.mbkj.dap.lab.LabFaultController');
  assert.equal(data.method, 'serverFault');
  assert.equal(data.file, 'LabFaultController.java');
  assert.equal(data.stackLine, 25);
  assert.equal(data.versionStatus, 'unchecked');
  assert.match(data.versionNote, /版本未核对/);
  assert.ok(data.startLine <= 25 && data.endLine >= 25, `${data.startLine}-${data.endLine}`);
  assert.match(data.text, /throw new IllegalStateException\("Real DataAsset lab fault injection"\)/);
  assert.match(data.text, /@Profile\("real-dataasset-lab"\)/);
  assert.match(data.text, /@ConditionalOnProperty/);
  assert.ok(data.text.split('\n').length <= 40);
  assert.ok(data.text.length <= 1500);
  assert.ok(!data.file.includes(DATAASSET_ROOT));
});

it('uses a stable evidence id for the same stack frame and does not duplicate rows', () => {
  const first = sourceSnippetEvidence({
    incident: incident(), evidence: [stackEvidence(DATAASSET_STACK)],
    roots: { [SERVICE]: DATAASSET_ROOT }, collectedAt: AT,
  });
  const second = sourceSnippetEvidence({
    incident: incident(), evidence: [stackEvidence(DATAASSET_STACK)],
    roots: { [SERVICE]: DATAASSET_ROOT }, collectedAt: '2026-10-14T04:00:00.000Z',
  });
  assert.ok(first && second);
  assert.equal(first.id, second.id);
  assert.equal(first.kind, 'source.snippet');
  assert.equal(first.status, 'succeeded');
  assert.equal(first.incidentId, 'inc-source-1');
});

it('refuses a frame whose file name tries to leave the root', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Inside.java'), 'class Inside {}\n'));
  assert.equal(snippet({ [SERVICE]: root }, 'at com.x.Out.run(../Inside.java:1)'), undefined);
  assert.equal(snippet({ [SERVICE]: root }, 'at com.x.Out.run(sub/Inside.java:1)'), undefined);
});

it('refuses a symlink that resolves outside the configured root', () => {
  const outside = tempRoot((directory) => writeFileSync(join(directory, 'Link.java'), 'class Link {}\n'));
  const root = tempRoot((directory) => symlinkSync(join(outside, 'Link.java'), join(directory, 'Link.java')));
  assert.equal(snippet({ [SERVICE]: root }, 'at com.x.Link.run(Link.java:1)'), undefined);
  rmSync(outside, { recursive: true, force: true });
});

it('skips JDK module frames and library jars before the first application frame', () => {
  const data = snippet({ [SERVICE]: DATAASSET_ROOT }, [
    'at java.base/java.lang.Thread.run(Thread.java:840)',
    'at org.springframework.web.Method.invoke(Method.java:100) ~[spring-web.jar:1]',
    DATAASSET_STACK,
  ].join('\n'));
  assert.equal(data?.className, 'com.mbkj.dap.lab.LabFaultController');
  assert.equal(data?.versionStatus, 'unchecked');
});

it('reports missing when two files share the stack file name', () => {
  const root = tempRoot((directory) => {
    mkdirSync(join(directory, 'one'));
    mkdirSync(join(directory, 'two'));
    writeFileSync(join(directory, 'one', 'Dup.java'), 'class Dup {}\n');
    writeFileSync(join(directory, 'two', 'Dup.java'), 'class Dup {}\n');
  });
  const data = snippet({ [SERVICE]: root }, 'at com.x.Dup.run(Dup.java:1)');
  assert.ok(data);
  assert.equal(data.versionStatus, 'missing');
  assert.match(data.versionNote, /同名/);
  assert.equal(data.text, '');
  rmSync(root, { recursive: true, force: true });
});

it('reports missing if the search limit prevents ruling out duplicate files', () => {
  const root = tempRoot((directory) => {
    writeFileSync(join(directory, 'Dup.java'), 'class Dup { void run() {} }');
    const nested = join(directory, ...Array.from({ length: 14 }, () => 'nested'));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'Dup.java'), 'class Dup { void run() {} }');
  });
  try {
    const data = snippet({ [SERVICE]: root }, 'at com.x.Dup.run(Dup.java:1)');
    assert.equal(data?.versionStatus, 'missing');
    assert.match(data?.versionNote ?? '', /搜索不完整/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports missing when the service has no configured root', () => {
  const data = snippet({});
  assert.ok(data);
  assert.equal(data.versionStatus, 'missing');
  assert.equal(data.text, '');
  assert.match(data.versionNote, new RegExp(SERVICE));
});

it('reports missing when the file is absent from a configured root', () => {
  const root = tempRoot(() => undefined);
  const data = snippet({ [SERVICE]: root });
  assert.ok(data);
  assert.equal(data.versionStatus, 'missing');
  assert.match(data.versionNote, /LabFaultController\.java/);
  rmSync(root, { recursive: true, force: true });
});

it('redacts assignment values for secret-shaped keys', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Secret.java'), [
    'package com.x;',
    'class Secret {',
    '    String password = "hunter2";',
    '    String apiKey = "sk-live-abc";',
    '    String client_secret = fetchSecret("embedded-secret");',
    '    String token = "prefix" + "suffix-secret";',
    '    private static final String access_token = "tok-123";',
    '    void run() {',
    '        use(password, apiKey);',
    '    }',
    '}',
    '',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at com.x.Secret.run(Secret.java:8)');
  assert.ok(data);
  assert.doesNotMatch(data.text, /hunter2|sk-live-abc|tok-123|embedded-secret|suffix-secret/);
  assert.match(data.text, /password = \[redacted\]/);
  rmSync(root, { recursive: true, force: true });
});

it('reports drifted when the method is not in the window or the line exceeds the file', () => {
  const body = ['package com.x;', 'class Drift {', ...Array.from({ length: 30 }, (_, index) => `    int f${index} = ${index};`), '}'];
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Drift.java'), `${body.join('\n')}\n`));
  const absent = snippet({ [SERVICE]: root }, 'at com.x.Drift.renamed(Drift.java:5)');
  assert.ok(absent);
  assert.equal(absent.versionStatus, 'drifted');
  assert.match(absent.versionNote, /renamed/);
  const beyond = snippet({ [SERVICE]: root }, 'at com.x.Drift.renamed(Drift.java:900)');
  assert.ok(beyond);
  assert.equal(beyond.versionStatus, 'drifted');
  assert.match(beyond.versionNote, /900/);
  rmSync(root, { recursive: true, force: true });
});

it('keeps a source snippet in the model context when the evidence slots are full', () => {
  const build = (id: string, kind: string): EvidenceRecord => ({
    id, incidentId: 'inc-source-1', nodeId: 'node-1', source: kind.split('.')[0]!, kind,
    collectedAt: AT, status: 'succeeded', data: { note: id },
  });
  const full = [
    build('evd-jfr', 'jfr.signal'), build('evd-inspect', 'docker.inspect'),
    build('evd-probe', 'http.probe'), build('evd-stats', 'docker.stats'),
    build('evd-memory', 'host.memory'), build('evd-load', 'host.load'),
    build('evd-disk', 'host.disk'), build('evd-logs', 'docker.logs'),
    build('evd-source', 'source.snippet'),
  ];
  const selected = selectEvidenceForContext(full, 8);
  assert.equal(selected.length, 8);
  assert.ok(selected.some((item) => item.kind === 'source.snippet'));
  const context = buildIncidentContext(incident(), full, { maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20 });
  assert.ok(context.evidence.some((item) => item.kind === 'source.snippet'));
});

it('keeps the snippet text in the model view and out of the detail markdown and raw evidence API', async () => {
  const store = createEventStore(':memory:');
  const created = store.createIncident({
    service: SERVICE, node_id: 'node-1', type: 'business.error', state: 'OPEN',
    fingerprint: 'f', first_seen: AT, last_seen: AT, event_count: 1, severity: 'error',
  });
  const evidence = sourceSnippetEvidence({
    incident: created, evidence: [stackEvidence(DATAASSET_STACK)],
    roots: { [SERVICE]: DATAASSET_ROOT }, collectedAt: AT,
  });
  assert.ok(evidence);
  store.insertEvidence(evidence);
  const context = buildIncidentContext(created, store.listEvidence(created.id), {
    maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20,
  });
  const modelView = context.evidence.find((item) => item.kind === 'source.snippet');
  assert.ok(modelView);
  assert.match(JSON.stringify(modelView), /Real DataAsset lab fault injection/);

  const brief = incidentBrief(store, created.id);
  assert.ok(brief);
  const markdown = renderIncidentBrief(brief);
  assert.doesNotMatch(markdown, /Real DataAsset lab fault injection/);
  assert.match(markdown, /LabFaultController\.java/);
  assert.match(markdown, /unchecked/);

  const payload = buildNotificationPayload({
    notificationId: 'n-1', type: 'INVESTIGATION_COMPLETED',
    incident: incidentFactsFromRow(created), evidenceIds: [evidence.id],
  });
  const message = formatWeComMarkdown(payload);
  assert.doesNotMatch(message, /Real DataAsset lab fault injection/);

  const config = makeAgentConfig();
  const app = createApp(config, store, createIncidentEngine(store, config));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    for (const view of ['raw', 'safe']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/v1/ops/incidents/${created.id}/evidence?view=${view}`, {
        headers: { Authorization: `Bearer ${config.operatorToken}` },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(body, /Real DataAsset lab fault injection/, view);
      assert.match(body, /LabFaultController\.java/, view);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
  }
});

it('keeps evidence identity when a missing root becomes a readable nested source file', () => {
  const root = tempRoot((directory) => {
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'LabFaultController.java'), 'class LabFaultController { void serverFault() {} }');
  });
  try {
    const input = { incident: incident(), evidence: [stackEvidence(DATAASSET_STACK)], collectedAt: AT };
    assert.equal(sourceSnippetEvidence({ ...input, roots: {} })?.id,
      sourceSnippetEvidence({ ...input, roots: { [SERVICE]: root } })?.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('redacts before the character limit can cut a secret literal', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Secret.java'), [
    'class Secret {', '  void run() {', `    String password = "${'sensitive'.repeat(300)}";`, '  }', '}',
  ].join('\n')));
  try {
    const data = snippet({ [SERVICE]: root }, 'at com.x.Secret.run(Secret.java:3)');
    assert.ok(data);
    assert.doesNotMatch(data.text, /sensitive/);
    assert.match(data.text, /\[redacted\]/);
    assert.equal(data.endLine, data.startLine + data.text.split('\n').length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reads the method declaration rather than a nearby recursive call', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Recurse.java'), [
    'class Recurse {', '  static int down(int depth) {', '    int markerOnlyInBody = depth;',
    '    return down(depth + 1) + depth;', '  }', '}',
  ].join('\n')));
  try {
    const data = snippet({ [SERVICE]: root }, 'at com.x.Recurse.down(Recurse.java:4)');
    assert.ok(data);
    assert.match(data.text, /static int down/);
    assert.match(data.text, /markerOnlyInBody/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not confuse a recursive return with a method declaration', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Recurse.java'), [
    'class Recurse {', '  static int down(int depth) {', '    int markerOnlyInBody = depth;',
    ...Array.from({ length: 81 }, () => ''), '    return down(depth + 1) + depth;', '  }', '}',
  ].join('\n')));
  try {
    const data = snippet({ [SERVICE]: root }, 'at com.x.Recurse.down(Recurse.java:85)');
    assert.ok(data);
    assert.equal(data.versionStatus, 'drifted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports the actual retained range after the character cap', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Long.java'), [
    'class Long {', '  void run() {', ...Array.from({ length: 15 }, () => `    use("${'x'.repeat(180)}");`), '  }', '}',
  ].join('\n')));
  try {
    const data = snippet({ [SERVICE]: root }, 'at com.x.Long.run(Long.java:3)');
    assert.ok(data);
    assert.ok(data.text.length <= 1500);
    assert.equal(data.endLine, data.startLine + data.text.split('\n').length - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('stores exactly one source row before building an investigation and reuses it on retry', () => {
  const store = createEventStore(':memory:');
  try {
    const { id: _id, ...fields } = incident();
    const created = store.createIncident(fields);
    store.insertEvidence({
      id: 'jfr-test', incidentId: created.id, nodeId: created.node_id, source: 'jfr',
      kind: 'jfr.signal', collectedAt: AT, status: 'succeeded', data: stackEvidence(DATAASSET_STACK).data,
    });
    const loop = createInvestigationLoopService(store, { sourceRoots: { [SERVICE]: DATAASSET_ROOT }, now: () => AT });
    const first = loop.start(created.id);
    const second = loop.start(created.id);
    assert.equal(first.session.id, second.session.id);
    assert.equal(store.listEvidence(created.id).filter((item) => item.kind === 'source.snippet').length, 1);
    const source = first.context.evidence.find((item) => item.kind === 'source.snippet');
    assert.ok(source);
    assert.match(JSON.stringify(source.data), /ConditionalOnProperty/);
  } finally {
    store.close();
  }
});

it('finds business source after MySQL and an unlisted third-party frame', () => {
  const data = snippet({ [SERVICE]: DATAASSET_ROOT }, [
    'at com.mysql.cj.jdbc.exceptions.SQLExceptionsMapping.translateException(SQLExceptionsMapping.java:122)',
    'at vendor.unknown.Proxy.invoke(Proxy.java:30)',
    DATAASSET_STACK,
  ].join('\n'));
  assert.equal(data?.file, 'LabFaultController.java');
  assert.equal(data?.versionStatus, 'unchecked');
  assert.match(data?.text ?? '', /throw new IllegalStateException/);
});

it('redacts passwords in connection URIs regardless of the variable name', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Connection.java'), [
    'class Connection {', '  void run() {',
    '    String endpoint = "mysql://alice:db-secret@db.example/app";',
    '    String cache = "redis://:redis-secret@cache.example:6379";',
    '  }', '}',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at app.Connection.run(Connection.java:3)');
  assert.ok(data);
  assert.doesNotMatch(data.text, /db-secret|redis-secret/);
  assert.match(data.text, /mysql:\/\/alice:\[redacted\]@db.example/);
  assert.match(data.text, /redis:\/\/:\[redacted\]@cache.example/);
});

it('refuses source files larger than one MiB before reading their content', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Huge.java'),
    'class Huge {\n  void run() {}\n}\n' + ' '.repeat(1024 * 1024)));
  const data = snippet({ [SERVICE]: root }, 'at app.Huge.run(Huge.java:2)');
  assert.equal(data?.versionStatus, 'missing');
  assert.equal(data?.text, '');
  assert.match(data?.versionNote ?? '', /源码文件过大，未读取/);
});

it('reads findUsers with a three-line parameter signature', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Users.java'), [
    'class Users {', '  public List<User> findUsers(', '      String name,', '      int limit) {',
    '    return repository.find(name, limit);', '  }', '}',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at app.Users.findUsers(Users.java:5)');
  assert.equal(data?.versionStatus, 'unchecked');
  assert.match(data?.text ?? '', /public List<User> findUsers\(/);
  assert.match(data?.text ?? '', /return repository.find/);
});

it('redacts a secret assignment spanning a Java text block without shifting line numbers', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Block.java'), [
    'class Block {', '  void run() {', '    String apiKey = """',
    '        first-secret-line', '        second-secret-line', '        """;',
    '    use(apiKey);', '  }', '}',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at app.Block.run(Block.java:7)');
  assert.ok(data);
  assert.doesNotMatch(data.text, /first-secret-line|second-secret-line/);
  assert.match(data.text, /\[redacted\]/);
  assert.equal(data.endLine, data.startLine + data.text.split('\n').length - 1);
});

it('ignores braces and parentheses in block comments when locating a method body', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Commented.java'), [
    'class Commented {', '  void run() {', '    /* } )', '       } { ( */',
    '    use("body-marker");', '  }', '}',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at app.Commented.run(Commented.java:5)');
  assert.equal(data?.versionStatus, 'unchecked');
  assert.match(data?.text ?? '', /body-marker/);
  assert.equal(data?.endLine, 6);
});

it('redacts Authorization headers and Bearer tokens under unrelated variable names', () => {
  const root = tempRoot((directory) => writeFileSync(join(directory, 'Headers.java'), [
    'class Headers {', '  void run() {',
    '    headers.put("Authorization", "Basic basic-secret");',
    '    String value = "Bearer bearer-secret";', '  }', '}',
  ].join('\n')));
  const data = snippet({ [SERVICE]: root }, 'at app.Headers.run(Headers.java:3)');
  assert.ok(data);
  assert.doesNotMatch(data.text, /basic-secret|bearer-secret/);
  assert.match(data.text, /\[redacted\]/);
});

it('loads source roots from the environment and rejects malformed values', () => {
  assert.deepEqual(loadSourceRoots({}), {});
  assert.deepEqual(loadSourceRoots({ PI_OPS_SOURCE_ROOTS: '{"svc":"/srv/code"}' }), { svc: '/srv/code' });
  assert.throws(() => loadSourceRoots({ PI_OPS_SOURCE_ROOTS: 'nope' }), /PI_OPS_SOURCE_ROOTS/);
  assert.throws(() => loadSourceRoots({ PI_OPS_SOURCE_ROOTS: '{"svc":"relative/path"}' }), /PI_OPS_SOURCE_ROOTS/);
  assert.throws(() => loadSourceRoots({ PI_OPS_SOURCE_ROOTS: '[]' }), /PI_OPS_SOURCE_ROOTS/);
});
