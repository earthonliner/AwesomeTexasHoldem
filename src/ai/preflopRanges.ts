import type { Card } from '../engine/types';
import { startingHandClass } from '../engine/preflopStrength';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Piecewise-linear interpolation through `points` sorted by x. Values outside
 * the range clamp to the end points, so no threshold produces a range cliff.
 */
function interpolate(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/**
 * Fraction of starting hands (all-in ordering) an opponent is assumed to shove
 * or re-shove with, as a continuous function of the wager in big blinds. A
 * 55BB jam does not carry a range 36% tighter than a 54.99BB jam.
 */
export function shoveRangeFraction(wagerBB: number): number {
  return interpolate(
    [
      [6, 0.34],
      [10, 0.24],
      [18, 0.14],
      [30, 0.09],
      [55, 0.05],
      [90, 0.04],
    ],
    wagerBB,
  );
}

/** Short jams from late position (only the blinds behind) are much wider. */
export const LATE_SHORT_JAM_WIDTH = 1.45;
export const SHORT_JAM_MAX_BB = 15;

/**
 * Multiplier on the positional opening range when stacks are shallow. Small
 * pairs and suited connectors lose their implied odds well before 3-bet
 * defence starts, so raise-first-in tightens from ~25BB down.
 */
export function shortStackOpenMultiplier(effectiveDepthBB: number): number {
  return clamp(0.72 + effectiveDepthBB / 90, 0.72, 1);
}

/** Effective depth at or below which raise-first-in is replaced by open-jam. */
export const OPEN_JAM_DEPTH_BB = 12;

/**
 * How much wider than the raise-first-in range an open-jam is, by the number
 * of players still to act. With only the blinds behind, a short stack jams far
 * more than it would open deep (fold equity plus blind pressure); from early
 * position the jam range is about the opening range.
 */
export function openJamWidth(playersBehind: number): number {
  return clamp(2.1 - 0.25 * Math.max(0, playersBehind), 1, 1.9);
}

/** Speculative hands folded first-in below this depth (no implied odds). */
export const SPECULATIVE_CUTOFF_DEPTH_BB = 22;

function handOf(hole: [Card, Card]): string {
  return startingHandClass(hole[0], hole[1]);
}

/**
 * Value 4-bet frequency by hand class. Explicit classes replace a percentile
 * on the playability ordering, so JJ/AQs/TT are depth-dependent mixes instead
 * of an accidental "top 3.2%" that used to include KQs and AJs.
 */
export function valueFourBetProbability(
  hole: [Card, Card],
  shallowPressure: number,
  deepRealisation: number,
): number {
  switch (handOf(hole)) {
    case 'AA':
    case 'KK':
      return 1;
    case 'QQ':
      return clamp(0.92 - deepRealisation * 0.25, 0, 1);
    case 'AKs':
      return clamp(0.9 - deepRealisation * 0.3, 0, 1);
    case 'AKo':
      return clamp(0.78 + shallowPressure * 0.22 - deepRealisation * 0.35, 0, 1);
    case 'JJ':
      return clamp(0.4 + shallowPressure * 0.55 - deepRealisation * 0.4, 0, 1);
    case 'AQs':
      return clamp(0.22 + shallowPressure * 0.5 - deepRealisation * 0.22, 0, 1);
    case 'TT':
      return clamp(shallowPressure * 0.7 - 0.1, 0, 1);
    case 'AQo':
      return clamp(shallowPressure * 0.45 - 0.1, 0, 1);
    default:
      return 0;
  }
}

/**
 * 5-bet (facing a 4-bet) frequency by hand class. AK stays a jam candidate at
 * every depth while JJ/TT only stack off short — a single percentile cannot
 * express both, because JJ ranks above AKs for playability.
 */
export function fiveBetProbability(
  hole: [Card, Card],
  shallowStackOff: number,
  deepFourBetPlay: number,
): number {
  switch (handOf(hole)) {
    case 'AA':
    case 'KK':
      return clamp(0.95 - deepFourBetPlay * 0.15, 0, 1);
    case 'QQ':
      return clamp(0.7 + shallowStackOff * 0.3 - deepFourBetPlay * 0.4, 0, 1);
    case 'AKs':
      return clamp(0.68 + shallowStackOff * 0.32 - deepFourBetPlay * 0.35, 0, 1);
    case 'AKo':
      return clamp(0.45 + shallowStackOff * 0.45 - deepFourBetPlay * 0.3, 0, 1);
    case 'JJ':
      return clamp(shallowStackOff * 0.6 - 0.05, 0, 1);
    case 'TT':
    case 'AQs':
      return clamp(shallowStackOff * 0.35 - 0.1, 0, 1);
    default:
      return 0;
  }
}

/**
 * Share of a 3-bettor's range that continues against a 4-bet jam, from the jam
 * size relative to the pot they would win by folding. Bigger jams into smaller
 * pots get called by a narrower slice.
 */
export function jamContinueFraction(jamRisk: number, potBefore: number): number {
  if (jamRisk <= 0) return 0.65;
  return clamp(0.28 + 0.22 * (potBefore / jamRisk), 0.25, 0.65);
}
