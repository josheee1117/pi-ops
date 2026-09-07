/**
 * Combine BASE detector + machine review / break-glass results into the
 * authoritative required-check outcome. This file never inspects HEAD code.
 */
export function finalDecision({
  detectStatus,
  detectDecision,
  detectRoute,
  machineReviewStatus,
  authorizeStatus,
}) {
  if (detectStatus !== 'success') return 'FAIL';
  if (detectDecision === 'PASS' || detectDecision === 'LOW_PASS') return 'PASS';

  // v2.1 explicit states. These aliases let the control plane move away from
  // the legacy HUMAN_REQUIRED umbrella without changing fail-closed semantics.
  if (detectDecision === 'MACHINE_REVIEW_REQUIRED') {
    return machineReviewStatus === 'success' ? 'PASS' : 'FAIL';
  }
  if (detectDecision === 'BREAK_GLASS_REQUIRED') {
    return authorizeStatus === 'success' ? 'PASS' : 'FAIL';
  }

  if (detectDecision === 'HUMAN_REQUIRED') {
    if (detectRoute === 'MACHINE_REVIEW') return machineReviewStatus === 'success' ? 'PASS' : 'FAIL';
    if (detectRoute === 'BREAK_GLASS') return authorizeStatus === 'success' ? 'PASS' : 'FAIL';
    // Legacy v2.0 compatibility: an older checker had no route and used the
    // Environment for HUMAN_REQUIRED.
    if (!detectRoute || detectRoute === 'NONE') return authorizeStatus === 'success' ? 'PASS' : 'FAIL';
    return 'FAIL';
  }

  if (detectDecision === 'REVIEW_REQUIRED') return authorizeStatus === 'success' ? 'PASS' : 'FAIL';
  if (detectDecision === 'REJECT' || detectDecision === 'INTERNAL_ERROR') return 'FAIL';
  return 'FAIL';
}

function isCli() {
  return process.argv[1]?.includes('final-decision.mjs') && !process.argv[1]?.includes('.test.');
}

if (isCli()) {
  const result = finalDecision({
    detectStatus: process.env.DETECT_RESULT,
    detectDecision: process.env.DETECT_DECISION,
    detectRoute: process.env.DETECT_ROUTE,
    machineReviewStatus: process.env.MACHINE_REVIEW_RESULT,
    authorizeStatus: process.env.AUTHORIZE_RESULT,
  });
  console.log(`final=${result}`);
  process.exit(result === 'PASS' ? 0 : 1);
}
