import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const POLICY_FILES = [
  'tools/test-governance/config/features.json',
  'tools/test-governance/config/catalog.json',
  'tools/test-governance/config/architecture-guards.json',
];
const WORKFLOW_FILES = [
  '.github/workflows/test-governance.yml',
  '.github/workflows/governance-trust-anchor.yml',
];
const PACKAGE_JSON = 'package.json';
const PROTECTED_SCRIPTS = [
  'test:gate',
  'test:plan',
  'test:run',
  'test:arch',
  'test:governance',
  'test:governance:self',
];
const PROTECTED_FIELDS = [
  'packageManager',
  'engines.node',
  'dependencies.typescript',
  'devDependencies.typescript',
];
const ACCEPTED_STATUS = new Set(['ACTIVE', 'PINNED']);

function globToRegExp(pattern) {
  const target = pattern.replaceAll('\\', '/');
  if (!target.includes('*')) return new RegExp(`^${target.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`);
  const escaped = target.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (target.endsWith('/**')) {
    const prefix = escaped.slice(0, -3).replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*');
    return new RegExp(`^${prefix}(?:/.*)?$`);
  }
  const body = escaped.replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${body}$`);
}

function matchesPath(file, pattern) {
  return globToRegExp(pattern).test(file.replaceAll('\\', '/'));
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function show(cwd, rev, path) {
  try {
    return git(cwd, ['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

function blobId(cwd, rev, path) {
  try {
    return git(cwd, ['rev-parse', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

function parseNameStatus(output) {
  const paths = [];
  for (const line of (output || '').split('\n').filter(Boolean)) {
    const [status, a, b] = line.split('\t');
    if (!status) continue;
    if (status.startsWith('R') && a && b) {
      paths.push(a, b);
    } else if (a) {
      paths.push(a);
    }
  }
  return [...new Set(paths)];
}

function fieldValue(pkg, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], pkg);
}

function parseJson(text, label) {
  if (text === null) return { present: false, value: null };
  try {
    return { present: true, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pnpmScriptName(command) {
  const match = String(command ?? '').trim().match(/^pnpm(?:\s+run)?\s+(\S+)$/);
  return match ? match[1] : null;
}

function acceptedEntries(catalog) {
  return (catalog?.entries ?? []).filter((entry) => ACCEPTED_STATUS.has(entry.status));
}

function invariantIds(features) {
  const ids = new Set();
  for (const feature of features?.features ?? []) {
    for (const invariant of feature.invariants ?? []) {
      if (invariant.id) ids.add(invariant.id);
    }
  }
  return ids;
}

function proofRecords(catalog) {
  const records = [];
  for (const entry of acceptedEntries(catalog)) {
    for (const proof of entry.proofs ?? []) {
      records.push({
        entryId: entry.id,
        featureId: entry.featureId,
        status: entry.status,
        invariantId: proof.invariantId,
        level: proof.level,
        executionClass: entry.executionClass ?? null,
        file: entry.location?.file ?? null,
        testName: entry.location?.testName ?? null,
        command: entry.command ?? null,
      });
    }
  }
  return records;
}

function definitionFingerprint(record) {
  return JSON.stringify({
    featureId: record.featureId,
    status: record.status,
    invariantId: record.invariantId,
    level: record.level,
    executionClass: record.executionClass,
    file: record.file,
    testName: record.testName,
    command: record.command,
  });
}

function classifyTrustPath(path) {
  if (matchesPath(path, 'tools/test-governance/src/**')) {
    return { kind: 'GOVERNANCE_ENGINE_CHANGED', file: path };
  }
  if (matchesPath(path, 'tools/test-governance/trust-anchor/**')) {
    return { kind: 'GOVERNANCE_ANCHOR_CHANGED', file: path };
  }
  if (WORKFLOW_FILES.includes(path)) {
    return { kind: 'GOVERNANCE_WORKFLOW_CHANGED', file: path };
  }
  if (POLICY_FILES.includes(path)) {
    return { kind: 'GOVERNANCE_POLICY_CHANGED', file: path };
  }
  return null;
}

function comparePackageEntrypoints(basePkg, headPkg) {
  const findings = [];
  const base = basePkg ?? {};
  const head = headPkg ?? {};
  for (const script of PROTECTED_SCRIPTS) {
    const before = base.scripts?.[script];
    const after = head.scripts?.[script];
    if (before === after) continue;
    findings.push({
      kind: 'GOVERNANCE_ENTRYPOINT_CHANGED',
      file: PACKAGE_JSON,
      field: `scripts.${script}`,
      detail: `package.json scripts["${script}"] ${before === undefined ? 'added' : after === undefined ? 'removed' : 'changed'}`,
    });
  }
  for (const field of PROTECTED_FIELDS) {
    const before = fieldValue(base, field);
    const after = fieldValue(head, field);
    if (before === after) continue;
    findings.push({
      kind: 'GOVERNANCE_ENTRYPOINT_CHANGED',
      file: PACKAGE_JSON,
      field,
      detail: `package.json ${field} changed`,
    });
  }
  return findings;
}

function addSourceFinding(bucket, { kind, file, entryId, invariantId, level, detail }) {
  const key = `${kind}\0${file}`;
  let item = bucket.get(key);
  if (!item) {
    item = {
      kind,
      file,
      detail,
      catalogEntryIds: [],
      invariantIds: [],
      levels: [],
    };
    bucket.set(key, item);
  }
  if (entryId && !item.catalogEntryIds.includes(entryId)) item.catalogEntryIds.push(entryId);
  if (invariantId && !item.invariantIds.includes(invariantId)) item.invariantIds.push(invariantId);
  if (level && !item.levels.includes(level)) item.levels.push(level);
}

function sortIds(values) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const kind = String(a.kind).localeCompare(String(b.kind));
    if (kind !== 0) return kind;
    return String(a.file ?? '').localeCompare(String(b.file ?? ''));
  }).map((item) => ({
    ...item,
    catalogEntryIds: item.catalogEntryIds ? sortIds(item.catalogEntryIds) : undefined,
    invariantIds: item.invariantIds ? sortIds(item.invariantIds) : undefined,
    levels: item.levels ? sortIds(item.levels) : undefined,
  }));
}

export function checkTrust({ cwd, base, head }) {
  if (!base || !head) throw new Error('base and head SHAs are required');
  git(cwd, ['rev-parse', '--verify', `${base}^{commit}`]);
  git(cwd, ['rev-parse', '--verify', `${head}^{commit}`]);

  const changedPaths = parseNameStatus(git(cwd, ['diff', '--name-status', '--find-renames', base, head]));
  const trustSurface = [];
  for (const path of changedPaths) {
    const classified = classifyTrustPath(path);
    if (classified) trustSurface.push(classified);
  }

  const basePkg = parseJson(show(cwd, base, PACKAGE_JSON), `${base}:${PACKAGE_JSON}`);
  const headPkg = parseJson(show(cwd, head, PACKAGE_JSON), `${head}:${PACKAGE_JSON}`);
  if (changedPaths.includes(PACKAGE_JSON)) {
    trustSurface.push(...comparePackageEntrypoints(basePkg.value, headPkg.value));
  }

  const baseFeatures = parseJson(show(cwd, base, POLICY_FILES[0]), `${base}:${POLICY_FILES[0]}`);
  const headFeatures = parseJson(show(cwd, head, POLICY_FILES[0]), `${head}:${POLICY_FILES[0]}`);
  const baseCatalog = parseJson(show(cwd, base, POLICY_FILES[1]), `${base}:${POLICY_FILES[1]}`);
  const headCatalog = parseJson(show(cwd, head, POLICY_FILES[1]), `${head}:${POLICY_FILES[1]}`);

  const baseInvariants = invariantIds(baseFeatures.value ?? { features: [] });
  const baseProofs = proofRecords(baseCatalog.value ?? { entries: [] });
  const headProofs = proofRecords(headCatalog.value ?? { entries: [] });
  const pairKey = (record) => `${record.entryId}\0${record.invariantId}`;
  const groupByPair = (records) => {
    const grouped = new Map();
    for (const record of records) {
      const key = pairKey(record);
      const list = grouped.get(key) ?? [];
      list.push(record);
      grouped.set(key, list);
    }
    return grouped;
  };
  const baseByPair = groupByPair(baseProofs);
  const headByPair = groupByPair(headProofs);
  const pairFingerprint = (records) => JSON.stringify(records.map(definitionFingerprint).sort());

  const changedDefinitions = [];
  const newProofs = [];
  const sourceBucket = new Map();

  for (const [key, baseRecords] of baseByPair) {
    const headRecords = headByPair.get(key);
    const sample = baseRecords[0];
    if (!headRecords) {
      changedDefinitions.push({
        kind: 'PROOF_DEFINITION_CHANGE_REQUIRES_REVIEW',
        file: sample.file ?? '',
        catalogEntryIds: [sample.entryId],
        invariantIds: [sample.invariantId],
        levels: sortIds(baseRecords.map((item) => item.level)),
        detail: `accepted proof removed: ${sample.entryId} ${sample.invariantId}`,
      });
      continue;
    }
    if (pairFingerprint(baseRecords) !== pairFingerprint(headRecords)) {
      changedDefinitions.push({
        kind: 'PROOF_DEFINITION_CHANGE_REQUIRES_REVIEW',
        file: headRecords[0].file ?? sample.file ?? '',
        catalogEntryIds: [sample.entryId],
        invariantIds: [sample.invariantId],
        levels: sortIds(headRecords.map((item) => item.level)),
        detail: `accepted proof definition changed: ${sample.entryId} ${sample.invariantId}`,
      });
    }
  }

  for (const [key, headRecords] of headByPair) {
    if (baseByPair.has(key)) continue;
    const sample = headRecords[0];
    const kind = baseInvariants.has(sample.invariantId)
      ? 'NEW_PROOF_REQUIRES_REVIEW'
      : 'PROOF_DEFINITION_REQUIRES_REVIEW';
    newProofs.push({
      kind,
      file: sample.file ?? '',
      catalogEntryIds: [sample.entryId],
      invariantIds: [sample.invariantId],
      levels: sortIds(headRecords.map((item) => item.level)),
      detail: kind === 'NEW_PROOF_REQUIRES_REVIEW'
        ? `new proof for existing invariant ${sample.invariantId}:${sample.level}`
        : `new invariant and proof ${sample.invariantId}:${sample.level}`,
    });
  }

  const seenFiles = new Set();
  for (const record of baseProofs) {
    if (record.file && !seenFiles.has(record.file)) {
      seenFiles.add(record.file);
      const before = blobId(cwd, base, record.file);
      const after = blobId(cwd, head, record.file);
      if (before !== after) {
        const pinned = baseProofs.some((item) => item.file === record.file && item.status === 'PINNED');
        const kind = pinned ? 'PINNED_PROOF_SOURCE_CHANGE_REQUIRES_REVIEW' : 'PROOF_SOURCE_CHANGE_REQUIRES_REVIEW';
        const detail = after === null ? `accepted proof source deleted: ${record.file}` : `accepted proof source changed: ${record.file}`;
        for (const item of baseProofs.filter((row) => row.file === record.file)) {
          addSourceFinding(sourceBucket, {
            kind,
            file: record.file,
            entryId: item.entryId,
            invariantId: item.invariantId,
            level: item.level,
            detail,
          });
        }
      }
    }
    const script = pnpmScriptName(record.command);
    if (!script) continue;
    const before = basePkg.value?.scripts?.[script];
    const after = headPkg.value?.scripts?.[script];
    if (before === after) continue;
    addSourceFinding(sourceBucket, {
      kind: record.status === 'PINNED' ? 'PINNED_PROOF_SOURCE_CHANGE_REQUIRES_REVIEW' : 'PROOF_SOURCE_CHANGE_REQUIRES_REVIEW',
      file: PACKAGE_JSON,
      entryId: record.entryId,
      invariantId: record.invariantId,
      level: record.level,
      detail: `command script binding scripts["${script}"] changed`,
    });
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    base,
    head,
    status: 'PASS',
    trustSurface: { findings: sortFindings(trustSurface) },
    proofIntegrity: {
      changedSources: sortFindings([...sourceBucket.values()]),
      changedDefinitions: sortFindings(changedDefinitions),
      newProofs: sortFindings(newProofs),
    },
  };
  const blocking = [
    ...result.trustSurface.findings,
    ...result.proofIntegrity.changedSources,
    ...result.proofIntegrity.changedDefinitions,
    ...result.proofIntegrity.newProofs,
  ];
  if (blocking.length > 0) result.status = 'GOVERNANCE_REVIEW_REQUIRED';
  return result;
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), json: false, base: null, head: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--cwd') options.cwd = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--head') options.head = argv[++i];
  }
  return options;
}

function printHuman(result) {
  console.log('GOVERNANCE TRUST ANCHOR');
  console.log(`base=${result.base} head=${result.head}`);
  console.log(`status=${result.status}`);
  const groups = [
    ['trustSurface', result.trustSurface.findings],
    ['changedSources', result.proofIntegrity.changedSources],
    ['changedDefinitions', result.proofIntegrity.changedDefinitions],
    ['newProofs', result.proofIntegrity.newProofs],
  ];
  for (const [label, findings] of groups) {
    if (findings.length === 0) continue;
    console.log(`${label}:`);
    for (const finding of findings) {
      console.log(`  - ${finding.kind} file=${finding.file || '-'} ${finding.detail}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = checkTrust({ cwd: options.cwd, base: options.base, head: options.head });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exit(result.status === 'PASS' ? 0 : 2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        status: 'INTERNAL_ERROR',
        error: message,
      }));
    } else {
      console.error(`GOVERNANCE TRUST ANCHOR INTERNAL_ERROR: ${message}`);
    }
    process.exit(1);
  }
}

function isCli() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isCli() || process.argv.includes('--base')) main();

