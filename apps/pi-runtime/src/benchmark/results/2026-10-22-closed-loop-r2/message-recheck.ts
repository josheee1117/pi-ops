import { readFileSync } from 'node:fs';
import { evidenceSchema, investigationReportInputSchema, specialistFindingSchema } from '@pi-ops/protocol';
import { evaluateMessage } from '../../evaluator.js';
import { MESSAGE_CASES } from '../../message-cases.js';

const batches = ['2026-10-21-closed-loop', '2026-10-22-closed-loop'];
const results = batches.map((batch) => ({
  batch,
  results: MESSAGE_CASES.map((sample) => {
    const source = JSON.parse(readFileSync(new URL(`../${batch}/${sample.id}.json`, import.meta.url), 'utf8')).result;
    const report = investigationReportInputSchema.parse(source.diagnosis.report);
    const findingsByRole = new Map<string, ReturnType<typeof specialistFindingSchema.parse>>();
    for (const call of source.diagnosis.modelCalls) {
      if (call.role === 'coordinator' || !call.text) continue;
      try {
        const parsed = specialistFindingSchema.safeParse(JSON.parse(call.text));
        if (parsed.success) findingsByRole.set(parsed.data.role, parsed.data);
      } catch { continue; }
    }
    const findings = [...findingsByRole.values()];
    const evidenceText = /## 证据摘要\n[^\n]+\n([\s\S]*?)\n完整证据读取：/.exec(source.detail.markdown)?.[1];
    if (!evidenceText) throw new Error(`${batch}/${sample.id}: missing saved evidence`);
    const evidence = evidenceSchema.array().parse(JSON.parse(evidenceText)).map((item) => {
      if (!item.status) throw new Error(`${batch}/${sample.id}: missing evidence status`);
      return { ...item, data: item.data, status: item.status };
    });
    const evaluation = evaluateMessage(sample.messageOracle!, report, findings, evidence, source.message.content);
    return {
      caseId: sample.id, oldMessageHardPass: source.diagnosis.messageHardPass,
      messageHardPass: evaluation.hardPass,
      failedChecks: Object.entries(evaluation.checks).filter(([, value]) => value.status === 'fail').map(([name, value]) => ({ name, detail: value.detail })),
      evaluation,
    };
  }),
}));
console.log(JSON.stringify({ mode: 'offline', modelCalls: 0, evidenceSource: 'saved detail markdown', findingsSource: 'last schema-valid output per specialist role', batches: results }, null, 2));
