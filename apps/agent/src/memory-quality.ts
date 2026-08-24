import type { MemoryFeedback } from './memory-feedback.js';
import type { MemoryEntry } from './memory-governance.js';

export interface MemoryQuality {
  successCount: number;
  failedCount: number;
  usageCount: number;
  effectivenessScore: number;
}

export interface MemoryIntelligence extends MemoryEntry, MemoryQuality {}

export function deriveMemoryQuality(
  feedbacks: MemoryFeedback[],
  fallbackEffectiveness: number,
): MemoryQuality {
  const successCount = feedbacks.filter((item) => item.outcome === 'SUCCESS').length;
  const failedCount = feedbacks.filter((item) => item.outcome === 'FAILED').length;
  const usageCount = feedbacks.length;
  const effectivenessScore = usageCount === 0
    ? fallbackEffectiveness
    : feedbacks.reduce((sum, item) => sum + item.effectivenessScore, 0) / usageCount;
  return { successCount, failedCount, usageCount, effectivenessScore };
}

export function successRatio(quality: MemoryQuality): number {
  const decided = quality.successCount + quality.failedCount;
  return decided === 0 ? 0.5 : quality.successCount / decided;
}

export function lastUsedAt(feedbacks: MemoryFeedback[]): string | undefined {
  let latest: string | undefined;
  for (const item of feedbacks) {
    if (!latest || item.createdAt > latest) latest = item.createdAt;
  }
  return latest;
}

export function withMemoryQuality(entry: MemoryEntry, quality: MemoryQuality): MemoryIntelligence {
  return { ...entry, ...quality };
}
