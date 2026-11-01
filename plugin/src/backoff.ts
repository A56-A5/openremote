export type BackoffOptions = {
  baseMs?: number;
  capMs?: number;
  /** 0..1 - how much the delay may deviate (±jitter/2) from the ideal. */
  jitter?: number;
  random?: () => number;
};

/**
 * Exponential backoff with symmetric jitter, capped.
 * attempt is 0-based (0 = first retry).
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 30_000;
  const jitter = opts.jitter ?? 0.3;
  const random = opts.random ?? Math.random;

  const ideal = Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
  const spread = ideal * jitter;
  const delay = ideal - spread / 2 + random() * spread;
  return Math.max(0, Math.min(cap, Math.round(delay)));
}
