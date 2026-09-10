/**
 * Thinking level configuration for the Pi Runtime model adapter.
 *
 * The set below is the real `ThinkingLevel` union from
 * `@earendil-works/pi-agent-core` 0.84.x, which the installed
 * `@earendil-works/pi-coding-agent` re-exports and passes to
 * `createAgentSession`.
 *
 * Production default stays `off` so this milestone does not change runtime
 * behavior. The Pi SDK silently clamps an unsupported level to what the model
 * supports; `parseThinkingLevel` deliberately does NOT copy that behavior —
 * an unknown value is rejected instead of falling back.
 */

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type RuntimeThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Production default. Unchanged by the benchmark milestone. */
export const DEFAULT_THINKING_LEVEL: RuntimeThinkingLevel = 'off';

export class UnsupportedThinkingLevelError extends Error {
  readonly code = 'unsupported_thinking_level';

  constructor(readonly value: string) {
    super(`unsupported thinking level: ${value} (expected one of ${THINKING_LEVELS.join(', ')})`);
    this.name = 'UnsupportedThinkingLevelError';
  }
}

export function isThinkingLevel(value: unknown): value is RuntimeThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Strict parse: unknown values throw. Never silently falls back. */
export function parseThinkingLevel(
  raw: string | undefined,
  fallback: RuntimeThinkingLevel = DEFAULT_THINKING_LEVEL,
): RuntimeThinkingLevel {
  if (raw === undefined || raw === '') return fallback;
  if (!isThinkingLevel(raw)) throw new UnsupportedThinkingLevelError(raw);
  return raw;
}
