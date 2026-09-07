# Test Governance v2.1 — Machine Review and Break-glass

## Goal

Routine governance changes must not require the repository owner to click a GitHub Environment approval that they will not meaningfully review.

The BASE Trust Anchor therefore separates governance changes into two trust tiers:

- **K0 / trust root** — code that directly controls authorization itself. These changes route to `BREAK_GLASS` and the existing `governance-review` Environment.
- **K1 / governance implementation** — semantically important governance code outside K0. These changes route to the read-only machine Reviewer + Critic.

Known deterministic weakenings remain `REJECT` and never enter either approval path.

## K0 trust root

K0 is intentionally small:

- `.github/workflows/governance-trust-anchor.yml`
- `tools/test-governance/trust-anchor/check.mjs`
- `tools/test-governance/trust-anchor/classify.mjs`
- `tools/test-governance/trust-anchor/final-decision.mjs`
- `tools/test-governance/trust-anchor/machine-review.mjs`

A human break-glass approval means only: **I intentionally asked for the referee itself to change.** It is not represented as a line-by-line human code review.

## K1 machine review

Examples include:

- `tools/test-governance/src/**`
- `.github/workflows/test-governance.yml`
- Trust Anchor tests under `tools/test-governance/trust-anchor/*.test.mjs`
- semantic policy / Proof changes that are not deterministically safe or deterministically weakening

The machine review job:

1. checks out BASE only;
2. treats HEAD as local git object/data;
3. executes only BASE `machine-review.mjs`;
4. sends a bounded deterministic context + unified diff to a configured OpenAI-compatible chat-completions endpoint;
5. performs two passes: Reviewer and adversarial Critic;
6. passes only when both return schema-valid `APPROVE` with no blocking findings;
7. fails closed on missing configuration, timeout/provider failure, malformed output, excessive diff size, or any reviewer disagreement;
8. has GitHub `contents: read` only and no merge, deployment, branch, shell-remediation, or repository-write capability.

Repository text is explicitly treated as untrusted data. Prompt text inside source, comments, docs, filenames, or commit messages has no local authorization meaning.

## One-time repository configuration

Configure these in **Settings → Secrets and variables → Actions**.

Repository secret:

- `GOVERNANCE_REVIEW_API_KEY`

Repository variables:

- `GOVERNANCE_REVIEW_API_URL` — full HTTPS OpenAI-compatible `chat/completions` endpoint
- `GOVERNANCE_REVIEWER_MODEL`
- `GOVERNANCE_CRITIC_MODEL` — optional; defaults to reviewer model when empty

No provider credential is committed to the repository.

Until these values are configured, a `MACHINE_REVIEW` change fails closed instead of falling back to a meaningless human approval.

## Final state machine

```text
PASS
  -> final PASS

LOW_PASS
  -> final PASS

HUMAN_REQUIRED + route=MACHINE_REVIEW
  -> Reviewer APPROVE + Critic APPROVE
  -> final PASS
  -> anything else final FAIL

HUMAN_REQUIRED + route=BREAK_GLASS
  -> governance-review Environment
  -> final PASS only after explicit human acknowledgement

REJECT / INTERNAL_ERROR
  -> final FAIL
```

## Merge enforcement

This workflow is only an effective merge gate after the repository protects `main` and requires the authoritative Trust Anchor `final` check. Human pull-request review is not intended to be a required check for this project.
