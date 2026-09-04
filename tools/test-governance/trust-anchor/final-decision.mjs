/**
 * Combine detector + authorization job results into the required-check outcome.
 * Detection stays in check.mjs. This file does not inspect HEAD.
 */
export function finalDecision({ detectStatus, detectDecision, authorizeStatus }) {
  if (detectStatus !== 'success') return 'FAIL';
  if (detectDecision === 'PASS' || detectDecision === 'LOW_PASS') return 'PASS';
  if (detectDecision === 'HUMAN_REQUIRED' || detectDecision === 'REVIEW_REQUIRED') {
    return authorizeStatus === 'success' ? 'PASS' : 'FAIL';
  }
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
    authorizeStatus: process.env.AUTHORIZE_RESULT,
  });
  console.log(`final=${result}`);
  process.exit(result === 'PASS' ? 0 : 1);
}
