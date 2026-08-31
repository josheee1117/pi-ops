import { canonicalizeCommand, catalogEntryKind } from './core.mjs';

/**
 * ExecutionPlan: the deterministic bridge from a policy plan (selected
 * catalog entries) to executable runs. A catalog entry is POTENTIAL evidence
 * only; the execution plan says what must actually run to realize it.
 *
 * Deduplication:
 * - TEST_FILE runs are grouped per file (whole-file execution with TAP
 *   verification that every selected testName actually ran).
 * - COMMAND runs are grouped per canonical executable form (argv), never per
 *   raw shell string, so shell control operators cannot reach the Runner.
 */

export const EXECUTION_CLASS_GATE = {
  UNIT: 1,
  COMPONENT: 1,
  INTEGRATION: 2,
  MULTI_PROCESS: 3,
  SMOKE: 3,
  LIVE_PROVIDER: 4,
};

export function gateForExecutionClass(executionClass) {
  const gate = EXECUTION_CLASS_GATE[executionClass];
  if (gate === undefined) {
    throw new Error(`UNKNOWN_EXECUTION_CLASS: ${executionClass ?? 'none'} (execution gate must never silently default)`);
  }
  return gate;
}

export function effectiveMaxGate(maxGate, allowLiveProvider) {
  const requested = Number.isInteger(maxGate) && maxGate >= 0 && maxGate <= 4 ? maxGate : 3;
  return allowLiveProvider ? requested : Math.min(requested, 3);
}

export function buildExecutionPlan({ plan, catalogEntries, maxGate = 3, allowLiveProvider = false, packageScripts = {} }) {
  const entryById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const fileGroups = new Map();
  const commandGroups = new Map();

  for (const item of plan.features ?? []) {
    for (const selected of item.plan.selected ?? []) {
      const entry = entryById.get(selected.id);
      if (!entry) throw new Error(`selected catalog entry is missing from validated catalog: ${selected.id}`);
      const kind = catalogEntryKind(entry);
      if (kind === 'TEST') {
        const group = fileGroups.get(entry.location.file) ?? { entries: [] };
        group.entries.push({ id: entry.id, testName: entry.location.testName, executionClass: entry.executionClass });
        fileGroups.set(entry.location.file, group);
      } else if (kind === 'COMMAND') {
        const { canonical, error } = canonicalizeCommand(entry.command, {
          packageScripts,
          declaredFile: entry.location?.file,
        });
        if (error) throw new Error(`UNEXECUTABLE_CATALOG_COMMAND: ${entry.id}: ${error}`);
        const key = JSON.stringify([canonical.executable, canonical.args]);
        const group = commandGroups.get(key) ?? { canonical, entries: [] };
        group.entries.push({ id: entry.id, executionClass: entry.executionClass });
        commandGroups.set(key, group);
      } else {
        throw new Error(`UNEXECUTABLE_CATALOG_ENTRY: ${entry.id} (execution shape ${kind})`);
      }
    }
  }

  const runs = [];
  for (const [file, group] of fileGroups) {
    const gate = Math.max(...group.entries.map((entry) => gateForExecutionClass(entry.executionClass)));
    const testNames = [];
    for (const entry of group.entries) {
      if (!testNames.includes(entry.testName)) testNames.push(entry.testName);
    }
    runs.push({ kind: 'TEST_FILE', file, testNames, entries: group.entries, gate });
  }
  for (const group of commandGroups.values()) {
    const gate = Math.max(...group.entries.map((entry) => gateForExecutionClass(entry.executionClass)));
    runs.push({
      kind: 'COMMAND',
      command: group.canonical.display,
      executable: group.canonical.executable,
      args: group.canonical.args,
      commandTarget: group.canonical.target,
      entries: group.entries,
      gate,
    });
  }

  const limit = effectiveMaxGate(maxGate, allowLiveProvider);
  runs.sort((left, right) => (
    left.gate - right.gate
    || left.kind.localeCompare(right.kind)
    || String(left.file ?? left.command).localeCompare(String(right.file ?? right.command))
  ));
  runs.forEach((run, index) => {
    run.runId = `run-${String(index + 1).padStart(3, '0')}`;
    run.planned = run.gate <= limit;
  });

  return {
    schemaVersion: 1,
    base: plan.base,
    head: plan.head,
    changedFiles: plan.changedFiles,
    changes: plan.changes ?? null,
    policyStatus: plan.status,
    features: (plan.features ?? []).map((item) => ({ id: item.feature.id, reason: item.reason })),
    maxGate: limit,
    runs,
  };
}
