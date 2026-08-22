/**
 * How long to wait before the next poll.
 *
 * Two jobs, and the second matters at scale. The obvious job is to stop a browser hammering
 * a failing backend. The less obvious job is **de-synchronisation**: without jitter, every
 * browser that started polling at the same moment — which, after an outage, is all of them —
 * retries in lockstep, and the backend that just came back up is knocked over by its own
 * clients. Jitter on the success path matters as much as on the failure path.
 *
 * Randomness is injected so the bounds can be asserted in tests instead of hoped for.
 */
export type RandomInRange = (low: number, high: number) => number;

/** The production source of randomness. */
export const SYSTEM_RANDOM: RandomInRange = (low, high) =>
  low >= high ? low : low + Math.random() * (high - low);

export class Backoff {
  constructor(
    /** Delay after the first failure, in seconds. Doubles from here. */
    private readonly baseSeconds = 2,
    /**
     * Ceiling, in seconds. Half an hour: a browser that has been failing for hours is
     * almost certainly offline, and there is nothing to gain from asking more often — the
     * cache is already answering every call.
     */
    public readonly capSeconds = 1800,
    /** Fraction of the computed delay to spread over, either side. 0.2 gives ±20%. */
    private readonly jitterFraction = 0.2,
  ) {}

  /** Delay in seconds before retrying after [consecutiveFailures] failures in a row. */
  retryDelaySeconds(consecutiveFailures: number, random: RandomInRange = SYSTEM_RANDOM): number {
    if (consecutiveFailures <= 0) return 0;
    // Exponent capped before the power so a long-lived offline browser cannot overflow the
    // multiplier into infinity on its ten-thousandth failed attempt.
    const exponent = Math.min(consecutiveFailures - 1, 32);
    const raw = Math.min(this.baseSeconds * Math.pow(2, exponent), this.capSeconds);
    return this.jittered(raw, random);
  }

  /** Delay in seconds before the next routine poll. */
  pollDelaySeconds(intervalSeconds: number, random: RandomInRange = SYSTEM_RANDOM): number {
    return this.jittered(intervalSeconds, random);
  }

  /**
   * A server that told us when to come back is obeyed, but never past the cap — a hostile
   * or misconfigured `Retry-After` of a year must not silently disable flag updates for a
   * browser until the tab is closed.
   */
  retryDelayWithServerHint(
    retryAfterSeconds: number | null,
    consecutiveFailures: number,
    random: RandomInRange = SYSTEM_RANDOM,
  ): number {
    if (retryAfterSeconds === null || retryAfterSeconds <= 0) {
      return this.retryDelaySeconds(consecutiveFailures, random);
    }
    return Math.min(retryAfterSeconds, this.capSeconds);
  }

  private jittered(seconds: number, random: RandomInRange): number {
    const spread = seconds * this.jitterFraction;
    return seconds + random(-spread, spread);
  }
}
