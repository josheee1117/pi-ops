/**
 * Chinese human-display presenter for the Governance Trust Anchor.
 *
 * This module is DISPLAY ONLY. It is a one-way projection:
 *
 *     machine decision  ->  display text
 *
 * Nothing here may feed back into authorization. `renderGovernanceSummary`
 * never mutates its input and never returns a decision. Machine codes
 * (PASS / REJECT / MACHINE_REVIEW / BREAK_GLASS / PROOF_SOURCE_CHANGED / ...)
 * stay in English and are always shown alongside their Chinese explanation.
 */

import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REASON_CODE_EXPLANATIONS = Object.freeze({
  PROOF_SOURCE_CHANGED: '已登记的证明源发生变化',
  PINNED_PROOF_SOURCE_CHANGE_REQUIRES_REVIEW: 'PINNED 证明源发生变化',
  PROOF_DEFINITION_CHANGED: '已登记的证明定义发生变化',
  PROOF_GRADE_DOWNGRADE: '已登记的证明等级被降低',
  PROOF_REMOVED: '已登记的证明被移除',
  PINNED_STATUS_CHANGED: 'PINNED 证明状态发生变化',
  NEW_PROOF: '新增了证明映射，需要确认',
  GOVERNANCE_ENGINE_CHANGED: '治理引擎代码发生变化',
  GOVERNANCE_ANCHOR_CHANGED: '治理信任锚代码发生变化',
  GOVERNANCE_WORKFLOW_CHANGED: '治理 Workflow 发生变化',
  GOVERNANCE_POLICY_CHANGED: '治理策略配置发生变化',
  GOVERNANCE_ENTRYPOINT_CHANGED: '受保护的治理入口发生变化',
  GOVERNANCE_ENTRYPOINT_REMOVED: '受保护的治理入口被移除',
  TRUST_ROOT_CHANGED: '治理信任根发生变化',
  TRUST_ROOT_REMOVED: '治理信任根被移除',
  TRUST_ROOT_WEAKENING: '治理信任根可能被削弱',
  MACHINE_REVIEW_SURFACE_CHANGED: '治理实现发生变化（AI 审查范围）',
  KERNEL_CHANGED: '治理内核代码发生变化',
  KERNEL_WEAKENING: '治理内核可能被削弱',
  PROOF_WEAKENING: '当前修改可能削弱已接受的测试证明',
  POLICY_WEAKENING: '治理策略可能被削弱',
  ARCHITECTURE_GUARD_WEAKENING: '架构守卫可能被削弱',
  UNCLASSIFIED_POLICY_CHANGE: '无法自动分类的治理策略变更',
  EVIDENCE_FLOOR_LOWERED: '测试证据要求被降低',
  EVIDENCE_FLOOR_RAISED: '测试证据要求被提高',
  EVIDENCE_GRADE_CHANGE_REQUIRES_REVIEW: '证明等级发生变化',
  GUARD_REMOVED: '架构守卫被移除',
  GUARD_SCOPE_SHRUNK: '架构守卫覆盖范围被缩小',
  GUARD_PATTERN_REMOVED: '架构守卫规则被移除',
  INVARIANT_REMOVED: '不变量被移除',
  FEATURE_REMOVED: 'Feature 被移除',
  FEATURE_PATH_REMOVED: 'Feature 路径被移除',
  FEATURE_PATH_ADDED: 'Feature 路径被新增',
  FEATURE_ADDED: '新增 Feature',
  NO_MACHINE_REVIEW_NEEDED: '无需 AI 审查',
});

/** Map one machine reason code to a Chinese explanation. Never throws. */
export function explainReasonCode(code) {
  const key = String(code ?? '').trim();
  if (!key) return '未知治理原因：<empty>';
  const known = REASON_CODE_EXPLANATIONS[key];
  if (known && known.length > 0) return known;
  return `未知治理原因：${key}`;
}

function reasonSection(reasonCodes) {
  const codes = Array.isArray(reasonCodes) ? reasonCodes : [];
  if (codes.length === 0) return [];
  const lines = ['### 原因', ''];
  for (const code of codes) {
    lines.push(`\`${code}\``);
    lines.push(`→ ${explainReasonCode(code)}`);
    lines.push('');
  }
  return lines;
}

function fileSection(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return [];
  const lines = ['涉及文件：', ''];
  for (const file of files) lines.push(`- \`${file}\``);
  lines.push('');
  return lines;
}

function reviewBlock(roleLabel, finding) {
  if (!finding || typeof finding !== 'object') return [];
  const lines = [`### ${roleLabel} 结论`, ''];
  const decision = finding.decision === 'APPROVE' ? '✅ 通过' : '❌ 拒绝';
  lines.push(`- decision：\`${finding.decision ?? 'unknown'}\`（${decision}）`);
  if (typeof finding.summary === 'string' && finding.summary.trim() !== '') {
    lines.push(`- 说明：${finding.summary.trim()}`);
  }
  const blocking = Array.isArray(finding.blockingFindings) ? finding.blockingFindings : [];
  if (blocking.length > 0) {
    lines.push('- 阻塞项：');
    for (const item of blocking) lines.push(`  - ${item}`);
  }
  lines.push('');
  return lines;
}

function riskBlock(reviewer, critic) {
  const notes = [
    ...(Array.isArray(reviewer?.riskNotes) ? reviewer.riskNotes : []),
    ...(Array.isArray(critic?.riskNotes) ? critic.riskNotes : []),
  ];
  if (notes.length === 0) return [];
  const lines = ['### 风险提示', ''];
  for (const note of notes) lines.push(`- ${note}`);
  lines.push('');
  return lines;
}

function header(title) {
  return ['## 🤖 Pi-Ops 自动治理结果', '', title, ''];
}

/**
 * Pure Markdown renderer. Returns a display string only.
 * Never mutates `input`, never derives or overrides an authorization verdict.
 */
export function renderGovernanceSummary(input = {}) {
  const {
    detectDecision = null,
    detectRoute = null,
    finalResult = null,
    machineReviewResult = null,
    authorizeResult = null,
    reasonCodes = [],
    labels = [],
    changedFiles = [],
    reviewer = null,
    critic = null,
    error = null,
  } = input ?? {};

  const route = detectRoute ?? 'NONE';
  const failed = finalResult === 'FAIL' || detectDecision === 'REJECT' || detectDecision === 'INTERNAL_ERROR';
  const machineApproved = machineReviewResult === 'success' && reviewer?.decision === 'APPROVE' && critic?.decision === 'APPROVE';
  const lines = [];

  if (route === 'BREAK_GLASS') {
    if (authorizeResult === 'success') {
      lines.push(...header('**结果：✅ 仓库所有者已确认，可以继续**'));
      lines.push('本次修改触及 Governance 信任根，owner 已完成确认。', '');
    } else {
      lines.push(...header('**结果：⚠️ 需要仓库所有者确认**'));
      lines.push('本次修改触及 Governance 信任根。', '');
      lines.push('你不需要逐行 Review 代码。', '');
      lines.push('只需要确认：', '');
      lines.push('> 我知道本次修改的是 Governance 自身，', '> 并且这是我有意进行的变更。', '');
      lines.push('确认后流程才能继续。', '');
      lines.push(`- route：\`${route}\``);
      lines.push('- 需要操作：在 GitHub 上批准 `governance-review` Environment', '');
    }
    lines.push(...fileSection(changedFiles));
    lines.push(...reasonSection(reasonCodes));
    if (error) lines.push(`- 内部错误信息：\`${error}\``, '');
    return lines.join('\n');
  }

  if (detectDecision === 'REJECT') {
    lines.push(...header('**结果：❌ 禁止合并**'));
    lines.push('这是 **确定性规则拒绝**，不是 AI Reviewer 的主观判断。', '');
    lines.push(...reasonSection(reasonCodes.length > 0 ? reasonCodes : labels));
    lines.push(...fileSection(changedFiles));
    lines.push('### 建议', '');
    lines.push('- 该文件已经作为正式 Proof Source；需要新增测试行为时优先新增独立测试文件。', '');
    lines.push('- 或显式更新 Proof 定义后重新进入治理流程。', '');
    return lines.join('\n');
  }

  if (route === 'MACHINE_REVIEW') {
    if (machineApproved) {
      lines.push(...header('**结果：✅ AI 自动审查通过**'));
      lines.push('- Reviewer：✅ 通过');
      lines.push('- Critic：✅ 通过');
      lines.push('- 人工确认：不需要', '');
      lines.push(...reviewBlock('Reviewer', reviewer));
      lines.push(...reviewBlock('Critic', critic));
      lines.push(...riskBlock(reviewer, critic));
      return lines.join('\n');
    }
    lines.push(...header('**结果：❌ AI Reviewer 拒绝**'));
    lines.push('这不是确定性规则拒绝，而是 AI Reviewer / Critic 的审查结论。', '');
    lines.push(`- machine-review 结果：\`${machineReviewResult ?? 'unknown'}\``);
    lines.push(`- Reviewer：\`${reviewer?.decision ?? 'unknown'}\``);
    lines.push(`- Critic：\`${critic?.decision ?? 'unknown'}\``, '');
    lines.push(...reviewBlock('Reviewer', reviewer));
    lines.push(...reviewBlock('Critic', critic));
    lines.push(...riskBlock(reviewer, critic));
    if (error) lines.push(`- 内部错误信息：\`${error}\``, '');
    lines.push('### 下一步建议', '');
    lines.push('- 阅读上方 Reviewer / Critic 的中文结论与风险提示。', '');
    lines.push('- 修正后重新 push，Trust Anchor 会重新运行。', '');
    return lines.join('\n');
  }

  if (!failed && (detectDecision === 'PASS' || detectDecision === 'LOW_PASS')) {
    lines.push(...header('**结果：✅ 可以合并**'));
    lines.push('- Trust Anchor：✅ 通过（确定性规则）');
    lines.push('- 无需 AI 审查');
    lines.push('- 无需人工操作', '');
    lines.push('> Test Governance Gate 是独立检查，请在 PR 页面查看其结果。', '');
    if (labels.length > 0) lines.push(...reasonSection(labels));
    return lines.join('\n');
  }

  lines.push(...header('**结果：❌ 禁止合并**'));
  lines.push(`- detect decision：\`${detectDecision ?? 'unknown'}\``);
  lines.push(`- route：\`${route}\``);
  lines.push(`- machine-review：\`${machineReviewResult ?? 'unknown'}\``);
  lines.push(`- authorize：\`${authorizeResult ?? 'unknown'}\``);
  lines.push(`- final：\`${finalResult ?? 'unknown'}\``, '');
  lines.push(...reasonSection(reasonCodes.length > 0 ? reasonCodes : labels));
  lines.push(...fileSection(changedFiles));
  if (error) lines.push(`- 内部错误信息：\`${error}\``, '');
  return lines.join('\n');
}

/** Extract reason codes from a BASE Trust Anchor detector result. */
export function anchorReasonCodes(anchor) {
  const authorization = anchor?.authorization ?? {};
  const codes = [
    ...(authorization.reasonCodes ?? []),
    ...(authorization.labels ?? []),
    ...(anchor?.proofIntegrity?.changedSources ?? []).map((item) => item?.kind),
    ...(anchor?.proofIntegrity?.changedDefinitions ?? []).map((item) => item?.kind),
    ...(anchor?.proofIntegrity?.newProofs ?? []).map((item) => item?.kind),
    ...(anchor?.trustSurface?.findings ?? []).map((item) => item?.kind),
  ];
  return [...new Set(codes.filter((code) => typeof code === 'string' && code !== ''))].sort();
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { out: null, anchor: null, audit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--anchor') options.anchor = argv[++i];
    else if (argv[i] === '--audit') options.audit = argv[++i];
  }
  return options;
}

function isCli() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isCli()) {
  // Display only: rendering problems must never become a governance veto.
  const options = parseArgs(process.argv.slice(2));
  const anchor = readJson(options.anchor);
  const audit = readJson(options.audit);
  const auditReviewer = audit?.reviewer ?? null;
  const auditCritic = audit?.critic ?? null;
  const summary = renderGovernanceSummary({
    detectDecision: process.env.DETECT_DECISION ?? anchor?.status ?? null,
    detectRoute: process.env.DETECT_ROUTE ?? anchor?.authorization?.route ?? null,
    finalResult: process.env.FINAL_RESULT ?? null,
    machineReviewResult: process.env.MACHINE_REVIEW_RESULT ?? null,
    authorizeResult: process.env.AUTHORIZE_RESULT ?? null,
    changedFiles: anchor?.authorization?.changedFiles ?? audit?.changedFiles ?? [],
    reasonCodes: anchorReasonCodes(anchor),
    labels: anchor?.authorization?.labels ?? [],
    reviewer: auditReviewer,
    critic: auditCritic,
    error: audit?.error ?? null,
  });
  const text = `${summary}\n`;
  if (options.out) {
    try {
      appendFileSync(options.out, text);
    } catch (error) {
      console.log(`::warning::governance summary could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    process.stdout.write(text);
  }
}
