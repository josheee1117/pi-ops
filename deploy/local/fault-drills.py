#!/usr/bin/env python3
"""Opt-in serial local fault matrix. Real Compose/demo only; never posts EventBatch."""
import argparse
import datetime as dt
import json
import hashlib
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess as sp
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'deploy/local'
PROJECT = 'pi-ops-jdk17-local'
JDK = Path('/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home')
CASES = ['W1-threshold-default', 'W1-default', 'W1', 'W2', 'W3', 'B1', 'B2', 'B3', 'B4', 'B5', 'N1-legacy', 'N1', 'N2', 'N3', 'F1-default', 'F1']
REPEAT = ['W1', 'W2', 'W3', 'B2', 'B3', 'B4', 'F1']
# The local smoke's non-secret operator credential; no ambient credential is used.
HEADERS = {'Authorization': 'Bearer local-operator-token'}
# Owner-confirmed test channel; never accept an ambient/CLI replacement for this pin.
TEST_NOTIFICATION_URL_SHA256 = '6598344a5e775ded5efaf0455f05854f473409c159ec58dfcbb8fd40ee7876e1'
# investigation-reconciler.ts starts a session only for these actions (or a missing health-binding).
INVESTIGATION_ACTIONS = ['analyze', 'alert']


def expects_session(decision, state=None):
    if not decision or decision.get('action') is None:
        return True
    if state in ('RECOVERED', 'CLOSED'):
        return False
    action = decision.get('action')
    return (action in INVESTIGATION_ACTIONS
            or 'health-binding' in (decision.get('missing') or []))


def expects_zero_notifications(decision):
    return (decision or {}).get('action') == 'record' and 'health-binding' not in ((decision or {}).get('missing') or [])


def notification_target_receipt(environment):
    digest = hashlib.sha256(environment.get('PI_OPS_NOTIFICATION_WEBHOOK_URL', '').encode()).hexdigest()
    kind = environment.get('PI_OPS_NOTIFICATION_WEBHOOK_KIND')
    attempts = str(environment.get('PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS'))
    batch = str(environment.get('PI_OPS_NOTIFICATION_JOB_BATCH_SIZE'))
    return {'at': stamp(), 'targetSha256': digest, 'expectedSha256': TEST_NOTIFICATION_URL_SHA256,
            'kind': kind, 'maxAttempts': attempts, 'batchSize': batch,
            'match': digest == TEST_NOTIFICATION_URL_SHA256 and kind == 'wecom' and attempts == '1' and batch == '1'}


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def get(url, method='GET', auth=False):
    req = urllib.request.Request(url, method=method, headers=HEADERS if auth else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except OSError as e:
        return 0, type(e).__name__


def until(check, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(1)
    raise TimeoutError('bounded wait expired')


class Run:
    def __init__(self, case, group, index, java_remediation=False):
        self.case = case
        self.java_remediation = java_remediation
        self.id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)
        self.path = LOCAL / 'data/jdk17' / self.id
        self.path.mkdir(parents=True, exist_ok=False)
        self.out = self.path / 'artifacts'
        self.out.mkdir()
        self.container = 'order-local-drill-' + self.id
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('PI_OPS_')}
        # Keep prior REAL config in ignored files, never serialize expanded Compose config.
        self.env.update(PI_OPS_JDK17_RUN_ID=self.id, FAULT_CONTAINER=self.container,
                        FAULT_SERVICE='order-service-本地演练-' + self.id,
                        FAULT_SENDER='true' if case.startswith('W') or case.startswith('F') or case.startswith('N1') or case == 'N2' else 'false',
                        FAULT_THRESHOLD='0.01' if case == 'N1-legacy' else ('1.0' if case == 'N2' else ('0.80' if case == 'W1-threshold-default' else '0.10')),
                        FAULT_THREADS='1' if case == 'N2' else '2',
                        FAULT_MEMORY='192m' if case == 'B2' else '512m',
                        FAULT_HEAP='256m' if case == 'B2' else '128m',
                        FAULT_RUNTIME_TIMEOUT='30000' if case in ['W1-default', 'W1-threshold-default'] else '300000',
                        FAULT_EVIDENCE_POLL='60000' if case == 'F1' else '1000')
        targets = [] if case in ['B2', 'B3', 'N3'] else [{'name': self.env['FAULT_SERVICE'], 'url': 'http://jdk17-drill:8088/health', 'container': self.container, 'intervalMs': 2000}]
        self.env['FAULT_HEALTH_TARGETS'] = json.dumps(targets)
        self.compose = ['docker', 'compose', '-p', PROJECT]
        for f in ['docker-compose.yml', 'docker-compose.jdk17.yml', 'docker-compose.fault-drills.yml']:
            self.compose += ['-f', str(LOCAL / f)]
        self.compose += ['--env-file', str(LOCAL / 'compose.env'), '--env-file', str(LOCAL / '.env.jdk17')]
        if java_remediation:
            # Replace both inherited sources: null/reset still resolves the old project env value.
            # Secret .env stays referenced in place; templates below contain no credential values.
            override = self.out / 'product-default-budget.compose.yml'
            override.write_text('services:\n  pi-runtime:\n    env_file: !override\n      - ' + str(LOCAL / '.env') + '\n    environment: !override\n      PI_OPS_PI_RUNTIME_TOKEN: ${PI_OPS_PI_RUNTIME_TOKEN:?}\n      PI_OPS_PI_RUNTIME_SQLITE_PATH: /data/pi-runtime/runtime.sqlite\n      PI_OPS_PI_RUNTIME_CALLBACK_URL: http://pi-ops:8080/v1/investigation-results\n      PI_OPS_REQUIRE_REAL_MODEL: "1"\n      PI_OPS_PI_MODEL: ${PI_OPS_JDK17_MODEL:-gpt-5.6-sol}\n      PI_OPS_PI_THINKING_LEVEL: "off"\n      PI_OPS_PI_RUNTIME_MAX_CONTEXT_BYTES: "65536"\n')
            self.compose += ['-f', str(override)]
            self.env.pop('FAULT_RUNTIME_TIMEOUT')
        self.truth = {'case': case, 'runId': self.id, 'group': group, 'index': index,
                      'startedAt': stamp(), 'actions': [], 'configuration': {k: v for k, v in self.env.items() if k.startswith('FAULT_')},
                      'limits': {'cpus': 2, 'memory': self.env['FAULT_MEMORY'], 'swap': self.env['FAULT_MEMORY']}}
        self.result = {'case': case, 'runId': self.id, 'evidenceDirectory': str(self.path), 'discovery': 'NOT_RUN', 'collection': 'NOT_RUN', 'diagnosis': 'NOT_RUN', 'notification': 'NOT_RUN', 'recovery': 'NOT_RUN', 'independentReview': 'NOT_RUN'}
        self.events = None
        self.event_file = None

    def save(self, name, value):
        (self.out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) if not isinstance(value, str) else value)

    def command(self, argv, check=True, timeout=90):
        with (self.out / 'commands.jsonl').open('a') as f:
            f.write(json.dumps({'at': stamp(), 'argv': argv}, ensure_ascii=False) + '\n')
        p = sp.run(argv, env=self.env, cwd=ROOT, text=True, stdout=sp.PIPE, stderr=sp.STDOUT, timeout=timeout)
        with (self.out / 'command-output.log').open('a') as f:
            f.write(p.stdout)
        if check and p.returncode:
            raise RuntimeError('command failed: ' + argv[0] + ' exit=' + str(p.returncode))
        return p.stdout

    def c(self, *args, **kw):
        return self.command(self.compose + list(args), **kw)

    def check_rendered_target(self):
        # Expanded config contains secrets: memory only, never use command() or log stdout/stderr.
        p = sp.run(self.compose + ['config', '--format', 'json'], env=self.env, cwd=ROOT, capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError('Offline Compose target check failed (details withheld)')
        config = json.loads(p.stdout)
        central = config['services']['pi-ops']
        receipt = notification_target_receipt(central['environment'])
        mounts = [v for v in central['volumes'] if v.get('target') == '/data/pi-ops']
        receipt['freshDatabaseMount'] = len(mounts) == 1 and mounts[0]['source'] == str(self.path / 'pi-ops') and not (self.path / 'pi-ops/pi-ops.sqlite').exists()
        self.save('notification-target-rendered.json', receipt)
        if self.java_remediation:
            runtime = config['services']['pi-runtime']['environment']
            absent = 'PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS' not in runtime
            self.save('budget-rendered.json', {'executionEnvAbsent': absent,
                'source': 'product default, not inherited 300s overlay',
                'centralStaleTimeoutMs': central['environment'].get('PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS', '900000'),
                'centralAsyncSubmitTimeoutMs': central['environment'].get('PI_OPS_PI_RUNTIME_TIMEOUT_MS', '5000')})
            if not absent:
                raise RuntimeError('Product-default budget still overridden; sender not started')
        if not receipt['match'] or not receipt['freshDatabaseMount']:
            raise RuntimeError('Test notification target or fresh database check failed; sender not started')

    def check_created_target(self):
        ident = sp.run(self.compose + ['ps', '-a', '-q', 'pi-ops'], env=self.env, cwd=ROOT, capture_output=True, text=True, timeout=30)
        if ident.returncode or not ident.stdout.strip():
            raise RuntimeError('Created notification service not found; sender not started')
        container = ident.stdout.strip()
        # Inspect only the needed fields; do not persist environment or unfiltered inspect.
        fmt = '{"environment":{{json .Config.Env}},"running":{{json .State.Running}},"mounts":{{json .Mounts}}}'
        p = sp.run(['docker', 'inspect', '--format', fmt, container], capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError('Created notification target check failed (details withheld)')
        config = json.loads(p.stdout)
        environment = dict(entry.split('=', 1) for entry in config['environment'])
        receipt = notification_target_receipt(environment)
        mounts = [v for v in config['mounts'] if v.get('Destination') == '/data/pi-ops']
        receipt['senderStopped'] = config['running'] is False
        receipt['freshDatabaseMount'] = len(mounts) == 1 and mounts[0]['Source'] == str(self.path / 'pi-ops') and not (self.path / 'pi-ops/pi-ops.sqlite').exists()
        self.save('notification-target-container.json', receipt)
        if not receipt['match'] or not receipt['senderStopped'] or not receipt['freshDatabaseMount']:
            raise RuntimeError('Actual notification target or stopped/fresh state check failed; sender not started')
        return container

    def check_created_runtime(self):
        ident = sp.run(self.compose + ['ps', '-a', '-q', 'pi-runtime'], env=self.env, cwd=ROOT, capture_output=True, text=True, timeout=30)
        if ident.returncode or not ident.stdout.strip():
            raise RuntimeError('Created Runtime not found; not started')
        container = ident.stdout.strip()
        fmt = '{"environment":{{json .Config.Env}},"running":{{json .State.Running}}}'
        p = sp.run(['docker', 'inspect', '--format', fmt, container], capture_output=True, text=True, timeout=30)
        config = json.loads(p.stdout) if p.returncode == 0 else {}
        absent = p.returncode == 0 and not any(e.startswith('PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS=') for e in config['environment'])
        stopped = config.get('running') is False
        self.save('budget-runtime-container.json', {'executionEnvAbsent': absent, 'runtimeStopped': stopped})
        if not absent or not stopped:
            raise RuntimeError('Runtime default budget not absent or Runtime not stopped; not started')
        return container

    def check_b4_bounds(self, data):
        if self.case != 'B4' and not self.java_remediation:
            return
        expected = {'W1': 'jvm.cpu_pressure', 'W2': 'jvm.oom', 'W3': 'business.error'}.get(self.case, 'health.failure')
        allowed_notifications = ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED'] if self.java_remediation else ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED', 'INCIDENT_RECOVERED']
        invalid = False
        if 'incidents' in data:
            items = data['incidents']
            invalid = len(items) > 1 or any(i['type'] != expected or i['service'] != self.env['FAULT_SERVICE'] for i in items)
        if 'notifications' in data:
            jobs = data['notifications']
            types = [j['type'] for j in jobs]
            invalid = invalid or len(types) > len(allowed_notifications) or len(set(types)) != len(types) or any(t not in allowed_notifications for t in types)
        if invalid:
            self.save('notification-safety-abort.json', {'at': stamp(), 'reason': 'unexpected scoped Incident/notification count or type'})
            self.c('stop', '--timeout', '0', 'pi-ops', 'pi-ops-node-agent', 'pi-runtime', check=False)
            raise RuntimeError('Unexpected scoped tasks; observer and sending services stopped immediately')

    def api(self, path):
        status, body = get('http://127.0.0.1:18080' + path, auth=True)
        if status != 200:
            raise RuntimeError('operator HTTP ' + str(status))
        data = json.loads(body)
        self.check_b4_bounds(data)
        return data

    def incidents(self):
        return self.api('/v1/ops/incidents')['incidents']

    def action(self, path):
        start = stamp()
        status, body = get('http://127.0.0.1:18089' + path, 'POST')
        self.truth['actions'].append({'at': start, 'path': path, 'status': status, 'body': body})
        self.flush()
        if status not in [200, 202, 500]:
            raise RuntimeError('workload request failed ' + str(status))
        return status

    def flush(self):
        (self.path / 'ground-truth.json').write_text(json.dumps(self.truth, ensure_ascii=False, indent=2))
        self.save('result.json', self.result)

    def snapshot(self, label, operator=True):
        for app, name in [('pi-ops', 'pi-ops.sqlite'), ('pi-runtime', 'runtime.sqlite')]:
            db = self.path / app / name
            if not db.exists():
                continue
            conn = sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)
            conn.row_factory = sqlite3.Row
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            export = {table: [dict(r) for r in conn.execute('SELECT * FROM "' + table + '"')] for table in tables}
            self.save(label + '-' + app + '-tables.json', export)
            backup = sqlite3.connect(self.out / (label + '-' + name))
            conn.backup(backup)
            backup.close()
            conn.close()
        if not operator:
            return
        try:
            incidents = self.incidents()
            self.save(label + '-incidents.json', incidents)
            for incident in incidents:
                ident = incident['id']
                for suffix in ['', '/evidence?view=raw', '/evidence']:
                    status, body = get('http://127.0.0.1:18080/v1/ops/incidents/' + ident + suffix, auth=True)
                    self.save(label + '-' + ident + '-' + (suffix.replace('/', '-').replace('?', '-') or 'detail') + '.json', {'httpStatus': status, 'body': body})
        except Exception as error:
            self.save(label + '-snapshot-error.txt', type(error).__name__)

    def jfr(self, label):
        # Independent binary recording; signal truth is the actual RecordingStream logs.
        self.command(['docker', 'exec', self.container, 'jcmd', '1', 'JFR.dump', 'name=observation', 'filename=/tmp/observation.jfr'], check=False)
        self.command(['docker', 'cp', self.container + ':/tmp/observation.jfr', str(self.out / (label + '.jfr'))], check=False)

    def prepare(self):
        self.check_rendered_target()
        self.c('stop', 'pi-ops-node-agent', 'pi-ops')
        self.c('stop', 'jdk17-drill', 'pi-runtime')
        if self.java_remediation:
            self.c('up', '--no-start', '--no-deps', '--force-recreate', 'pi-runtime')
            validated_runtime = self.check_created_runtime()
            self.command(['docker', 'start', validated_runtime])
            self.c('up', '-d', '--no-deps', '--force-recreate', 'jdk17-drill')
        else:
            self.c('up', '-d', '--no-deps', '--force-recreate', 'pi-runtime', 'jdk17-drill')
        until(lambda: get('http://127.0.0.1:18089/health')[0] == 200)
        until(lambda: get('http://127.0.0.1:18090/health')[0] == 200)
        self.save('container-jdk-version.txt', self.command(['docker', 'exec', self.container, 'java', '-version']))
        self.command(['docker', 'exec', self.container, 'jcmd', '1', 'JFR.start', 'name=observation', 'settings=profile', 'maxsize=16m', 'disk=true'])
        self.event_file = (self.out / 'docker-events.jsonl').open('w')
        self.events = sp.Popen(['docker', 'events', '--format', '{{json .}}', '--filter', 'container=' + self.container], stdout=self.event_file, stderr=sp.STDOUT)
        time.sleep(2)  # Do not replay replacement lifecycle into fresh DB.
        self.c('up', '-d', '--no-deps', '--force-recreate', 'pi-ops-node-agent')
        until(lambda: get('http://127.0.0.1:18081/health')[0] == 200)
        self.c('up', '--no-start', '--no-deps', '--force-recreate', 'pi-ops')
        validated_container = self.check_created_target()
        # Start this exact validated container, not a new Compose render/recreation.
        self.command(['docker', 'start', validated_container])
        until(lambda: get('http://127.0.0.1:18080/health')[0] == 200)
        for port in [18080, 18081, 18089, 18090]:
            status, body = get('http://127.0.0.1:' + str(port) + '/health')
            self.save('ready-' + str(port) + '.json', {'httpStatus': status, 'body': body})
        runtime = json.loads(get('http://127.0.0.1:18090/health')[1])
        if runtime.get('modelMode') != 'REAL':
            raise RuntimeError('REAL required')
        self.result['runtime'] = runtime
        if self.java_remediation:
            # Actual Env remains memory-only; persist only absence and effective non-secret timeout.
            p = sp.run(['docker', 'inspect', '--format', '{{json .Config.Env}}', PROJECT + '-pi-runtime-1'], capture_output=True, text=True, timeout=30)
            actual = json.loads(p.stdout) if p.returncode == 0 else []
            absent = p.returncode == 0 and not any(e.startswith('PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS=') for e in actual)
            self.save('budget-effective.json', {'executionEnvAbsent': absent, 'executionTimeoutMs': runtime.get('executionTimeoutMs'), 'source': 'product default'})
            if not absent or runtime.get('executionTimeoutMs') != 300000:
                self.c('stop', '--timeout', '0', 'pi-ops', 'pi-ops-node-agent', 'pi-runtime', check=False)
                raise RuntimeError('Effective product-default budget mismatch; sending services stopped')
        # Warmup is outside baseline but retained; don't remove startup Incidents.
        time.sleep(5)
        self.snapshot('before')
        if self.java_remediation and self.incidents():
            self.c('stop', '--timeout', '0', 'pi-ops', 'pi-ops-node-agent', 'pi-runtime', check=False)
            raise RuntimeError('Unexpected baseline Incident before authorized Java action')

    def settle(self, seconds=330):
        def terminal():
            incidents = self.incidents()
            if not incidents:
                return False
            for incident in incidents:
                detail = self.api('/v1/ops/incidents/' + incident['id'])
                sessions = detail.get('sessions', [])
                if not sessions:
                    decision = detail.get('notificationDecision') or {}
                    state = (detail.get('incident') or incident).get('state')
                    db = self.path / 'pi-ops/pi-ops.sqlite'
                    try:
                        conn = sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)
                        try:
                            jobs = [row[0] for row in conn.execute(
                                "SELECT state FROM evidence_jobs WHERE incident_id=?",
                                (incident['id'],),
                            ).fetchall()]
                        finally:
                            conn.close()
                    except sqlite3.OperationalError:
                        return False
                    if not expects_session(decision, state):
                        # Policy does not expect a session; wait until evidence collection finishes.
                        if not jobs or any(s not in ('COMPLETED', 'FAILED') for s in jobs):
                            return False
                        if any(e.get('status') not in ['succeeded', 'failed'] for e in detail.get('evidence', [])):
                            return False
                    else:
                        if not any(s == 'FAILED' for s in jobs):
                            return False
                elif any(s['status'] not in ['COMPLETED', 'FAILED'] for s in sessions):
                    return False
                if any(n['status'] not in ['DELIVERED', 'FAILED'] for n in detail.get('notifications', [])):
                    return False
            return True
        try:
            until(terminal, seconds)
        except TimeoutError:
            self.result['settleTimeout'] = True
        self.snapshot('settled')
        incidents = self.incidents()
        self.result['incidentIds'] = [i['id'] for i in incidents]
        expected = 'jvm.cpu_pressure' if self.case.startswith(('W1', 'F1')) else {'W2': 'jvm.oom', 'W3': 'business.error', 'B2': 'container.oom', 'B3': 'container.die', 'B4': 'health.failure'}.get(self.case)
        self.result['discovery'] = 'PASS' if incidents and (expected is None or any(i['type'] == expected for i in incidents)) else 'FAIL'
        details = [self.api('/v1/ops/incidents/' + i['id']) for i in incidents]
        ev = [e for d in details for e in d.get('evidence', [])]
        self.result['collection'] = 'PASS' if ev and all(e['status'] == 'succeeded' for e in ev) else 'GAP'
        sessions = [s for d in details for s in d.get('sessions', [])]
        decisions = [d.get('notificationDecision') or {} for d in details]
        states = [(d.get('incident') or {}).get('state') for d in details]
        self.result['notificationDecisions'] = [
            {'incidentId': (d.get('incident') or {}).get('id'), 'action': x.get('action'), 'reason': x.get('reason')}
            for d, x in zip(details, decisions)]
        no_session_expected = bool(details) and all(
            not expects_session(x, s) for x, s in zip(decisions, states))
        zero_notifications_expected = bool(details) and all(
            expects_zero_notifications(x) for x in decisions)
        # COMPLETED alone is not factual diagnosis acceptance; independent reviewer must score.
        self.result['diagnosis'] = 'NOT_RUN' if not sessions else ('BLOCKED' if any(s['status'] == 'COMPLETED' for s in sessions) else 'FAIL')
        if no_session_expected and not sessions:
            self.result['diagnosis'] = 'NOT_EXPECTED'
        self.result['sessionStatuses'] = [s['status'] for s in sessions]
        jobs = [n for d in details for n in d.get('notifications', [])]
        if zero_notifications_expected:
            self.result['notification'] = 'PASS' if not jobs else 'FAIL'
        else:
            self.result['notification'] = 'PASS' if jobs and all(n['status'] == 'DELIVERED' for n in jobs) else 'FAIL'
        self.result['notificationJobs'] = [{'id': n['id'], 'type': n['type'], 'status': n['status']} for n in jobs]

    def execute(self):
        self.prepare()
        case = self.case
        if case.startswith('W1') or case == 'W2' or case == 'W3':
            self.action('/cpu' if case.startswith('W1') else ('/heap' if case == 'W2' else '/order'))
            time.sleep(12)
            self.save('post-action-health.json', {'status': get('http://127.0.0.1:18089/health')[0]})
            if case == 'W1-threshold-default':
                self.snapshot('observed')
                self.result['discovery'] = 'PASS' if self.incidents() else 'FAIL'
            else:
                self.settle(80 if case == 'W1-default' else 330)
            self.result['recovery'] = 'GAP'  # No recovery event mapping for these types.
        elif case in ['B1', 'B5', 'N2'] or case.startswith('N1'):
            if case in ['B1', 'N2']:
                self.action('/cpu')
            elif case == 'B5':
                self.action('/order')
            time.sleep(45 if case.startswith('N1') else 15)
            self.snapshot('observed')
            incidents = self.incidents()
            self.result['incidentIds'] = [i['id'] for i in incidents]
            self.result['discovery'] = 'GAP' if case in ['B1', 'B5'] and not incidents else ('PASS' if not incidents else 'FAIL')
            self.save('post-action-health.json', {'status': get('http://127.0.0.1:18089/health')[0]})
            if incidents:
                self.settle()
                self.result['discovery'] = 'FAIL'
        elif case in ['B2', 'B3']:
            self.jfr('before-exit')
            self.action('/heap' if case == 'B2' else '/exit-nonzero')
            until(lambda: 'false' in self.command(['docker', 'inspect', '--format', '{{.State.Running}}', self.container]), 40)
            self.settle()
        elif case == 'B4':
            self.action('/fail')
            time.sleep(12)
            self.settle()
            self.snapshot('continued-failure')
            self.action('/ok')
            def recovery_delivered():
                items = self.incidents()
                if len(items) != 1 or items[0]['state'] != 'RECOVERED':
                    return False
                jobs = self.api('/v1/ops/incidents/' + items[0]['id']).get('notifications', [])
                return len(jobs) == 3 and all(n['status'] in ['DELIVERED', 'FAILED'] for n in jobs)
            until(recovery_delivered, 30)
            self.snapshot('recovered')
            items = self.incidents()
            self.result['recovery'] = 'PASS' if len(items) == 1 and items[0]['state'] == 'RECOVERED' else 'FAIL'
            jobs = [n for item in items for n in self.api('/v1/ops/incidents/' + item['id']).get('notifications', [])]
            self.result['notificationJobs'] = [{'id': n['id'], 'type': n['type'], 'status': n['status']} for n in jobs]
            self.result['notification'] = 'PASS' if len(jobs) == 3 and all(n['status'] == 'DELIVERED' for n in jobs) else 'FAIL'
        elif case == 'N3':
            self.jfr('before-exit')
            self.action('/exit')
            time.sleep(5)
            self.snapshot('normal-exit')
            self.c('start', 'jdk17-drill')
            time.sleep(10)
            self.snapshot('normal-restart')
            self.result['discovery'] = 'GAP' if self.incidents() else 'PASS'
            if self.incidents():
                self.settle()
                self.result['discovery'] = 'GAP'
        elif case.startswith('F1'):
            self.c('stop', 'pi-ops-node-agent')
            self.truth['actions'].append({'at': stamp(), 'operation': 'Node stopped', 'nodeHealth': get('http://127.0.0.1:18081/health')[0]})
            self.action('/cpu')
            def failed():
                db = self.path / 'pi-ops/pi-ops.sqlite'
                with sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True) as conn:
                    return conn.execute("SELECT count(*) FROM evidence WHERE status='failed' AND failure_class='retryable'").fetchone()[0] > 0
            until(failed, 30)
            self.snapshot('node-unavailable')
            if case == 'F1-default':
                time.sleep(6)
                self.snapshot('default-budget')
            self.c('start', 'pi-ops-node-agent')
            self.truth['actions'].append({'at': stamp(), 'operation': 'Node started'})
            until(lambda: get('http://127.0.0.1:18081/health')[0] == 200)
            self.settle(45 if case == 'F1-default' else 330)
        self.flush()

    def cleanup(self):
        # Observer first, then health restoration, then stop bounded workload. No deletion.
        try:
            self.c('stop', 'pi-ops-node-agent', check=False)
            status, body = get('http://127.0.0.1:18089/ok', 'POST')
            self.save('cleanup-health.json', {'status': status, 'body': body})
            state = self.command(['docker', 'inspect', '--format', '{{json .State}}', self.container], check=False)
            self.save('docker-state.json', state)
            self.save('docker-limits.json', self.command(['docker', 'inspect', '--format', '{"Memory":{{.HostConfig.Memory}},"MemorySwap":{{.HostConfig.MemorySwap}},"NanoCpus":{{.HostConfig.NanoCpus}},"RestartCount":{{.RestartCount}},"Image":"{{.Image}}"}', self.container], check=False))
            if '"Running":true' in state:
                self.jfr('final')
            for svc in ['jdk17-drill', 'pi-ops-node-agent', 'pi-ops', 'pi-runtime']:
                self.save(svc + '.log', self.c('logs', '--no-color', '--timestamps', svc, check=False))
            self.snapshot('final')
            self.c('stop', 'jdk17-drill', check=False)
            # Close SQLite writers before authoritative host-volume exports.
            self.c('stop', 'pi-ops', 'pi-runtime', check=False)
            self.snapshot('after-stop', operator=False)
        finally:
            if self.events:
                self.events.terminate()
                self.events.wait(timeout=5)
                self.event_file.close()
            self.truth['finishedAt'] = stamp()
            self.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true', help='consent: real local Docker/model/WeCom operations')
    parser.add_argument('--cases', default=','.join(CASES))
    parser.add_argument('--repeat-core', action='store_true')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--java-remediation', action='store_true', help='Java-only scoped safety guard and actual product-default budget')
    args = parser.parse_args()
    if not args.execute:
        parser.error('--execute required; reads existing gitignored credentials and sends real notifications')
    cases = args.cases.split(',')
    if any(c not in CASES for c in cases):
        parser.error('unknown case')
    if args.java_remediation and (args.repeat_core or any(c not in ['W1', 'W2', 'W3'] for c in cases)):
        parser.error('Java remediation accepts only explicit W1/W2/W3 cases, no full core repeat')
    for f in ['.env', '.env.jdk17', '.env.jdk17-models.json']:
        if not (LOCAL / f).exists():
            parser.error('missing ignored credentials file')
    group = LOCAL / 'data/fault-drills' / dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')
    group.mkdir(parents=True, exist_ok=False)
    subprocess_version = sp.run(['docker', 'version'], capture_output=True, text=True, check=True)
    (group / 'docker-version.txt').write_text(subprocess_version.stdout)
    (group / 'git-head.txt').write_text(sp.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True))
    (group / 'jdk-version.txt').write_text(sp.run([str(JDK / 'bin/java'), '-version'], capture_output=True, text=True, check=True).stderr)
    (group / 'integration.diff').write_text(sp.check_output(['git', 'diff'], cwd=ROOT, text=True))
    results = []
    print('Evidence group:', group, flush=True)
    if args.repeat_core:
        cases += REPEAT
    for index, case in enumerate(cases):
        run = Run(case, str(group), index, java_remediation=args.java_remediation)
        print('START', case, run.id, flush=True)
        try:
            if args.build and index == 0:
                run.check_rendered_target()
                run.c('stop', 'pi-ops-node-agent', 'pi-ops')
                run.c('build', 'jdk17-drill', 'pi-ops', 'pi-runtime', 'pi-ops-node-agent', timeout=1200)
            run.execute()
        except Exception as error:
            run.result['executionError'] = type(error).__name__ + ': ' + str(error)
            print('BLOCKED', case, type(error).__name__, flush=True)
        finally:
            run.cleanup()
            results.append(run.result)
            (group / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            print('END', case, json.dumps(run.result, ensure_ascii=False), flush=True)
        if args.java_remediation and ('executionError' in run.result or run.result.get('sessionStatuses') != ['COMPLETED'] or run.result['notification'] != 'PASS'):
            for remaining in cases[index + 1:]:
                results.append({'case': remaining, 'discovery': 'NOT_RUN', 'reason': 'stopped after scoped run failure; no automatic retry'})
            (group / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            break
        time.sleep(10)  # serial notifications, below robot rate (20/min), including recovery
    print('FINISHED', group, flush=True)


if __name__ == '__main__':
    main()
