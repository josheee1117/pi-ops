"""Runner configuration regressions only; no Docker, model, credentials or notifications."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import hashlib
import re
import sqlite3
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('fault_drills', Path(__file__).with_name('fault-drills.py'))
drills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drills)


class FaultDrillsConfigurationTest(unittest.TestCase):
    def test_java_uses_absent_budget_override_and_bounds_each_independent_case(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            for case, event_type in [('W1', 'jvm.cpu_pressure'), ('W2', 'jvm.oom'), ('W3', 'business.error')]:
                run = drills.Run(case, 'unit-only', 0, java_remediation=True)
                self.assertNotIn('FAULT_RUNTIME_TIMEOUT', run.env)
                config = (run.out / 'product-default-budget.compose.yml').read_text()
                self.assertNotIn('PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS', config)
                self.assertIn('env_file: !override', config)
                self.assertIn('environment: !override', config)
                self.assertIn('PI_OPS_REQUIRE_REAL_MODEL: "1"', config)
                self.assertIn('PI_OPS_PI_RUNTIME_TOKEN: ${PI_OPS_PI_RUNTIME_TOKEN:?}', config)
                run.check_b4_bounds({'incidents': [{'type': event_type, 'service': run.env['FAULT_SERVICE']}]})
                run.check_b4_bounds({'notifications': [{'type': t} for t in ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED']]})
                with patch.object(run, 'c') as stop:
                    with self.assertRaisesRegex(RuntimeError, 'stopped immediately'):
                        run.check_b4_bounds({'notifications': [{'type': 'INCIDENT_RECOVERED'}]})
                    stop.assert_called_once()

    def test_runtime_is_checked_stopped_with_budget_environment_absent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('W1', 'unit-only', 0, java_remediation=True)
            config = {'environment': ['PI_OPS_PI_RUNTIME_TOKEN=unit-only-sentinel'], 'running': False}
            def response(*args, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps(config) if 'inspect' in args[0] else 'runtime-unit')
            with patch.object(drills.sp, 'run', side_effect=response):
                self.assertEqual(run.check_created_runtime(), 'runtime-unit')
                config['environment'].append('PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS=30000')
                with self.assertRaisesRegex(RuntimeError, 'not started'):
                    run.check_created_runtime()
                config['environment'].pop()
                config['running'] = True
                with self.assertRaisesRegex(RuntimeError, 'not started'):
                    run.check_created_runtime()
            self.assertNotIn('unit-only-sentinel', (run.out / 'budget-runtime-container.json').read_text())

    def test_exact_target_mapping_and_no_ambient_pi_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)), patch.dict(os.environ, {'PI_OPS_PI_API_KEY': 'unit-only-sentinel', 'PI_OPS_NOTIFICATION_WEBHOOK_URL': 'unit-only-sentinel'}):
            run = drills.Run('W1', 'unit-only', 0)
            self.assertNotIn('PI_OPS_PI_API_KEY', run.env)
            self.assertNotIn('PI_OPS_NOTIFICATION_WEBHOOK_URL', run.env)
            target = json.loads(run.env['FAULT_HEALTH_TARGETS'])[0]
            self.assertEqual(target['container'], run.container)
            self.assertEqual(target['name'], run.env['FAULT_SERVICE'])
            self.assertEqual(run.env['FAULT_SENDER'], 'true')
            self.assertEqual(run.env['FAULT_RUNTIME_TIMEOUT'], '300000')
            self.assertNotIn('W1', run.container)

    def test_blackbox_limits_and_default_timeout_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            oom = drills.Run('B2', 'unit-only', 0)
            self.assertEqual(oom.env['FAULT_SENDER'], 'false')
            self.assertEqual(oom.env['FAULT_MEMORY'], '192m')
            self.assertEqual(oom.env['FAULT_HEAP'], '256m')
            self.assertEqual(json.loads(oom.env['FAULT_HEALTH_TARGETS']), [])
            cpu = drills.Run('B1', 'unit-only', 1)
            self.assertEqual(cpu.env['FAULT_SENDER'], 'false')
            self.assertEqual(len(json.loads(cpu.env['FAULT_HEALTH_TARGETS'])), 1)
            default = drills.Run('W1-default', 'unit-only', 2)
            self.assertEqual(default.env['FAULT_RUNTIME_TIMEOUT'], '30000')
            self.assertEqual(default.env['FAULT_THRESHOLD'], '0.10')
            self.assertNotEqual(oom.id, cpu.id)
            outage = drills.Run('F1', 'unit-only', 3)
            self.assertEqual(outage.env['FAULT_EVIDENCE_POLL'], '60000')

    def test_legacy_smoke_identity_and_fault_identity_override(self):
        local = Path(__file__).parent
        smoke = (local / 'smoke-jdk17.sh').read_text()
        overlay = (local / 'docker-compose.jdk17.yml').read_text()
        fault = (local / 'docker-compose.fault-drills.yml').read_text()
        service = re.search(r"const service = '([^']+)';", smoke).group(1)
        container = re.search(r'^    container_name: (.+)$', overlay, re.M).group(1)
        self.assertEqual(re.search(r'^      SERVICE_NAME: (.+)$', overlay, re.M).group(1), service)
        self.assertEqual(re.search(r'^      CONTAINER_NAME: (.+)$', overlay, re.M).group(1), container)
        self.assertIn('SERVICE_NAME: ${FAULT_SERVICE:?}', fault)
        self.assertIn('CONTAINER_NAME: ${FAULT_CONTAINER:?}', fault)

    def test_digest_pin_and_single_attempt_serial_configuration(self):
        self.assertEqual(drills.TEST_NOTIFICATION_URL_SHA256, '6598344a5e775ded5efaf0455f05854f473409c159ec58dfcbb8fd40ee7876e1')
        endpoint = 'https://example.invalid/unit-only'
        env = {'PI_OPS_NOTIFICATION_WEBHOOK_URL': endpoint, 'PI_OPS_NOTIFICATION_WEBHOOK_KIND': 'wecom',
               'PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS': '1', 'PI_OPS_NOTIFICATION_JOB_BATCH_SIZE': '1'}
        self.assertFalse(drills.notification_target_receipt(env)['match'])
        with patch.object(drills, 'TEST_NOTIFICATION_URL_SHA256', hashlib.sha256(endpoint.encode()).hexdigest()):
            self.assertTrue(drills.notification_target_receipt(env)['match'])
            for field, value in [('PI_OPS_NOTIFICATION_WEBHOOK_URL', endpoint + '-different'),
                                 ('PI_OPS_NOTIFICATION_WEBHOOK_KIND', 'generic'),
                                 ('PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS', '5'),
                                 ('PI_OPS_NOTIFICATION_JOB_BATCH_SIZE', '20')]:
                self.assertFalse(drills.notification_target_receipt({**env, field: value})['match'])
            self.assertNotIn(endpoint, json.dumps(drills.notification_target_receipt(env)))

    def test_rendered_mismatch_prevents_any_start_and_does_not_save_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('B4', 'unit-only', 0)
            config = {'services': {'pi-ops': {'environment': {'PI_OPS_NOTIFICATION_WEBHOOK_URL': 'unit-only-sentinel'},
                        'volumes': [{'target': '/data/pi-ops', 'source': str(run.path / 'pi-ops')}]}}}
            with patch.object(drills.sp, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(config))), patch.object(run, 'c') as compose:
                with self.assertRaisesRegex(RuntimeError, 'sender not started'):
                    run.prepare()
                compose.assert_not_called()
            self.assertNotIn('unit-only-sentinel', (run.out / 'notification-target-rendered.json').read_text())

    def test_created_environment_is_checked_while_sender_stopped(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('B4', 'unit-only', 0)
            endpoint = 'https://example.invalid/unit-only'
            config = {'environment': ['PI_OPS_NOTIFICATION_WEBHOOK_URL=' + endpoint, 'PI_OPS_NOTIFICATION_WEBHOOK_KIND=wecom',
                       'PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS=1', 'PI_OPS_NOTIFICATION_JOB_BATCH_SIZE=1'],
                      'running': False, 'mounts': [{'Destination': '/data/pi-ops', 'Source': str(run.path / 'pi-ops')}]}
            def response(*args, **kwargs):
                return SimpleNamespace(returncode=0, stdout='unit-container' if args[0][0] != 'docker' or 'inspect' not in args[0] else json.dumps(config))
            with patch.object(drills, 'TEST_NOTIFICATION_URL_SHA256', hashlib.sha256(endpoint.encode()).hexdigest()), patch.object(drills.sp, 'run', side_effect=response):
                self.assertEqual(run.check_created_target(), 'unit-container')
                config['running'] = True
                with self.assertRaisesRegex(RuntimeError, 'sender not started'):
                    run.check_created_target()
                config['running'] = False
                config['environment'][0] += '-different'
                with self.assertRaisesRegex(RuntimeError, 'sender not started'):
                    run.check_created_target()
            self.assertNotIn(endpoint, (run.out / 'notification-target-container.json').read_text())

    def test_prepare_validates_before_starting_exact_created_container(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('B4', 'unit-only', 0)
            calls = []
            with patch.object(run, 'check_rendered_target', side_effect=lambda: calls.append('render-validated')), \
                 patch.object(run, 'c', side_effect=lambda *a, **kw: calls.append(a)), \
                 patch.object(run, 'check_created_target', side_effect=lambda: calls.append('container-validated') or 'unit-container'), \
                 patch.object(run, 'command', side_effect=lambda a, **kw: calls.append(tuple(a)) or 'unit-output'), \
                 patch.object(run, 'snapshot'), patch.object(drills.time, 'sleep'), \
                 patch.object(drills.sp, 'Popen'), patch.object(drills, 'get', return_value=(200, '{"modelMode":"REAL"}')):
                run.prepare()
            run.event_file.close()
            self.assertEqual(calls[0], 'render-validated')
            create = ('up', '--no-start', '--no-deps', '--force-recreate', 'pi-ops')
            start = ('docker', 'start', 'unit-container')
            self.assertLess(calls.index(create), calls.index('container-validated'))
            self.assertLess(calls.index('container-validated'), calls.index(start))
            self.assertNotIn(('up', '-d', '--no-deps', '--force-recreate', 'pi-ops'), calls)

    def test_unexpected_b4_tasks_stop_sending_services(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('B4', 'unit-only', 0)
            run.check_b4_bounds({'notifications': [{'type': t} for t in ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED', 'INCIDENT_RECOVERED']]})
            with patch.object(run, 'c') as compose:
                with self.assertRaisesRegex(RuntimeError, 'stopped immediately'):
                    run.check_b4_bounds({'notifications': [{'type': 'INCIDENT_OPEN'}, {'type': 'INCIDENT_OPEN'}]})
                compose.assert_called_once_with('stop', '--timeout', '0', 'pi-ops', 'pi-ops-node-agent', 'pi-runtime', check=False)


class FaultDrillsSettleTest(unittest.TestCase):
    """Settle and result judgement against the 2026-10-22 B3 detail JSON shape (offline)."""

    def detail(self, action='record', reason='container-exit-without-oom', missing=(), evidence='succeeded',
               sessions=(), notifications=()):
        return {
            'incident': {'id': 'inc-b3', 'type': 'container.die', 'state': 'OPEN'},
            'evidence': [{'id': 'e' + str(i), 'kind': kind, 'status': evidence}
                         for i, kind in enumerate(['docker.inspect', 'docker.logs'])],
            'sessions': list(sessions),
            'notificationDecision': {'policyVersion': 1, 'evaluatedAt': '2026-10-22T02:37:14.877Z', 'action': action,
                                     'reason': reason, 'missing': list(missing), 'valueKeys': []},
            'notifications': list(notifications),
        }

    def settle(self, detail, incident_state=None, failed_jobs=0):
        with tempfile.TemporaryDirectory() as directory, patch.object(drills, 'LOCAL', Path(directory)):
            run = drills.Run('B3', 'unit-only', 0)
            (run.path / 'pi-ops').mkdir()
            with sqlite3.connect(run.path / 'pi-ops/pi-ops.sqlite') as conn:
                conn.execute('CREATE TABLE evidence_jobs (incident_id TEXT, state TEXT)')
                conn.execute("INSERT INTO evidence_jobs VALUES ('inc-b3', 'COMPLETED')")
                for _ in range(failed_jobs):
                    conn.execute("INSERT INTO evidence_jobs VALUES ('inc-b3', 'FAILED')")
            incident = {'id': 'inc-b3', 'type': 'container.die', 'state': incident_state or detail['incident']['state']}
            def once(check, seconds=None):
                if not check():
                    raise TimeoutError('unit-only: not settled on the first check')
            with patch.object(run, 'incidents', return_value=[incident]), \
                 patch.object(run, 'api', return_value=detail), \
                 patch.object(run, 'snapshot'), \
                 patch.object(drills, 'until', side_effect=once):
                run.settle()
            return run.result

    def test_record_decision_settles_without_a_session(self):
        result = self.settle(self.detail())
        self.assertNotIn('settleTimeout', result)
        self.assertEqual(result['diagnosis'], 'NOT_EXPECTED')
        self.assertEqual(result['notification'], 'PASS')
        self.assertEqual(result['sessionStatuses'], [])
        self.assertEqual(result['notificationDecisions'],
                         [{'incidentId': 'inc-b3', 'action': 'record', 'reason': 'container-exit-without-oom'}])

    def test_record_decision_waits_for_unfinished_evidence(self):
        result = self.settle(self.detail(evidence='pending'))
        self.assertTrue(result['settleTimeout'])
        self.assertEqual(result['diagnosis'], 'NOT_EXPECTED')

    def test_record_decision_with_a_notification_fails(self):
        job = {'id': 'n1', 'type': 'INCIDENT_OPEN', 'status': 'DELIVERED'}
        result = self.settle(self.detail(notifications=[job]))
        self.assertEqual(result['notification'], 'FAIL')

    def test_missing_health_binding_still_waits_for_the_session(self):
        result = self.settle(self.detail(reason='health-binding-missing', missing=['health-binding']))
        self.assertTrue(result['settleTimeout'])
        self.assertEqual(result['diagnosis'], 'NOT_RUN')
        self.assertEqual(result['notification'], 'FAIL')

    def test_investigated_case_keeps_waiting_for_a_session(self):
        result = self.settle(self.detail(action='analyze', reason='sustained-impact-unknown'))
        self.assertTrue(result['settleTimeout'])
        self.assertEqual(result['diagnosis'], 'NOT_RUN')

    def test_missing_decision_is_not_treated_as_record(self):
        detail = self.detail()
        del detail['notificationDecision']
        result = self.settle(detail)
        self.assertTrue(result['settleTimeout'])
        self.assertEqual(result['diagnosis'], 'NOT_RUN')

    def test_completed_session_keeps_the_existing_judgement(self):
        job = {'id': 'n1', 'type': 'INCIDENT_OPEN', 'status': 'DELIVERED'}
        result = self.settle(self.detail(action='alert', reason='jvm-oome',
                                        sessions=[{'id': 's1', 'status': 'COMPLETED'}], notifications=[job]))
        self.assertNotIn('settleTimeout', result)
        self.assertEqual(result['diagnosis'], 'BLOCKED')
        self.assertEqual(result['notification'], 'PASS')
        self.assertEqual(result['sessionStatuses'], ['COMPLETED'])


if __name__ == '__main__':
    unittest.main()
