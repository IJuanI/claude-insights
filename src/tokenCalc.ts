/**
 * Shared token counting and billing calculations.
 *
 * Centralises the formulas so that every call-site (webview, agent parser,
 * session usage) stays consistent.
 */

export interface TokenTotals {
  /** All tokens processed: input + output + cacheRead + cacheCreate */
  total: number;
  /** Estimated billed tokens: input + output + cacheCreate + round(cacheRead * 0.1) */
  billed: number;
}

/**
 * Compute total and billed token counts from the four raw counters.
 */
export function computeTokenTotals(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): TokenTotals {
  return {
    total: input + output + cacheRead + cacheCreate,
    billed: input + output + cacheCreate + Math.round(cacheRead * 0.1),
  };
}
