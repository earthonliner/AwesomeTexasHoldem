import type { Card, Rank } from '../engine/types';

/**
 * Pre-flop hand strength as a percentile (0..1, where 1 = AA, the strongest).
 *
 * Rather than estimating equity vs random cards (which makes almost every hand
 * look like a coin-flip and produces robotic, overly-tight ranges), we rank the
 * 169 canonical starting hands by a poker-sensible heuristic and return where a
 * given hand falls in that ranking. This lets the AI open/defend by "range" the
 * way humans actually think (e.g. "play my top 25%").
 */
function rawScore(hi: Rank, lo: Rank, pair: boolean, suited: boolean): number {
  const gap = hi - lo;
  let s = (hi + lo) / 28; // high-card weight
  if (pair) {
    s += 0.5 + (hi - 2) * 0.03; // pairs are premium, scaled by rank
  } else {
    if (suited) s += 0.08;
    if (gap === 1) s += 0.09; // connected
    else if (gap === 2) s += 0.05;
    else if (gap === 3) s += 0.02;
    else if (gap >= 5) s -= 0.04; // big gaps are weak
    if (hi === 14) s += 0.06; // ace-high holdings retain value
    if (hi >= 12) s += 0.03; // broadway cards
  }
  return s;
}

const SORTED_SCORES: number[] = (() => {
  const scores: number[] = [];
  for (let hi = 14; hi >= 2; hi--) {
    for (let lo = hi; lo >= 2; lo--) {
      if (hi === lo) {
        scores.push(rawScore(hi as Rank, lo as Rank, true, false));
      } else {
        scores.push(rawScore(hi as Rank, lo as Rank, false, true)); // suited
        scores.push(rawScore(hi as Rank, lo as Rank, false, false)); // offsuit
      }
    }
  }
  return scores.sort((a, b) => a - b);
})();

/** Percentile (0..1) of this two-card hand among all starting hands. */
export function preflopPercentile(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank) as Rank;
  const lo = Math.min(a.rank, b.rank) as Rank;
  const score = rawScore(hi, lo, a.rank === b.rank, a.suit === b.suit);

  // Fraction of canonical hands no stronger than this one.
  let count = 0;
  for (const s of SORTED_SCORES) {
    if (s <= score) count++;
    else break;
  }
  return count / SORTED_SCORES.length;
}
