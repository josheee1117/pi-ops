/**
 * Hysteresis state machine that requires N consecutive samples above
 * threshold before firing, and N consecutive samples below threshold
 * before recovering. Prevents event flooding from transient spikes.
 */
export interface HysteresisState {
  /** Feed a sample. Returns transition type if threshold is crossed. */
  sample(isAboveThreshold: boolean): 'pressure' | 'recovery' | null;
  reset(): void;
}

export function createHysteresisState(consecutiveRequired: number): HysteresisState {
  let consecutiveCount = 0;
  let isActive = false; // currently in pressure state

  return {
    sample(isAboveThreshold: boolean): 'pressure' | 'recovery' | null {
      if (!isActive) {
        // Currently healthy — counting samples above threshold
        if (isAboveThreshold) {
          consecutiveCount++;
          if (consecutiveCount >= consecutiveRequired) {
            isActive = true;
            consecutiveCount = 0;
            return 'pressure';
          }
        } else {
          consecutiveCount = 0;
        }
      } else {
        // Currently in pressure — counting samples below threshold
        if (!isAboveThreshold) {
          consecutiveCount++;
          if (consecutiveCount >= consecutiveRequired) {
            isActive = false;
            consecutiveCount = 0;
            return 'recovery';
          }
        } else {
          consecutiveCount = 0;
        }
      }
      return null;
    },

    reset(): void {
      consecutiveCount = 0;
      isActive = false;
    },
  };
}