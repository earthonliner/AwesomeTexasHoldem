import type { Card, Rank } from './types';

const RANK_SYMBOL: Record<Rank, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: 'T',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

/**
 * Canonical 169-grid name (for example AA, A5s or KQo).
 */
export function startingHandClass(a: Card, b: Card): string {
  const hi = Math.max(a.rank, b.rank) as Rank;
  const lo = Math.min(a.rank, b.rank) as Rank;
  if (hi === lo) return `${RANK_SYMBOL[hi]}${RANK_SYMBOL[lo]}`;
  return `${RANK_SYMBOL[hi]}${RANK_SYMBOL[lo]}${a.suit === b.suit ? 's' : 'o'}`;
}

/**
 * A playability-aware pre-flop score.
 *
 * It deliberately values pairs, suited wheel aces and suited connectors more
 * than a raw high-card sum. This is not an all-in-equity table: it is intended
 * to order hands for cash-game opening and defence ranges.
 */
export function preflopScore(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = hi === lo;
  const suited = a.suit === b.suit;

  if (pair) {
    // All pairs retain set value; premiums still separate clearly at the top.
    return 49 + (hi - 2) * 4.25;
  }

  const gap = hi - lo;
  let score = (hi - 2) * 3.2 + (lo - 2) * 1.35;

  if (hi === 14) score += 16;
  else if (hi === 13) score += 10;
  else if (hi === 12) score += 6;

  if (lo >= 10) score += 10; // two Broadway cards
  if (suited) score += 9;

  if (gap === 1) score += 13;
  else if (gap === 2) score += 7;
  else if (gap === 3) score += 3;
  else if (gap >= 5) score -= (gap - 4) * 1.35;

  // Suited wheel aces make nut flushes and disguised straights.
  if (hi === 14 && suited && lo <= 5) score += 8;

  return score;
}

const COMBO_WEIGHTED_SCORES: number[] = (() => {
  const scores: number[] = [];
  for (let hi = 14; hi >= 2; hi--) {
    for (let lo = hi; lo >= 2; lo--) {
      if (hi === lo) {
        const a = { rank: hi as Rank, suit: 's' as const };
        const b = { rank: lo as Rank, suit: 'h' as const };
        for (let i = 0; i < 6; i++) scores.push(preflopScore(a, b));
      } else {
        const suitedA = { rank: hi as Rank, suit: 's' as const };
        const suitedB = { rank: lo as Rank, suit: 's' as const };
        const offB = { rank: lo as Rank, suit: 'h' as const };
        for (let i = 0; i < 4; i++) scores.push(preflopScore(suitedA, suitedB));
        for (let i = 0; i < 12; i++) scores.push(preflopScore(suitedA, offB));
      }
    }
  }
  return scores.sort((x, y) => x - y);
})();

/**
 * Combo-weighted percentile among all 1,326 starting combinations.
 * 1 is strongest. Unlike a 169-cell percentile, pairs/suited/offsuit classes
 * carry their real 6/4/12 combination weights.
 */
export function preflopPercentile(a: Card, b: Card): number {
  const score = preflopScore(a, b);
  let count = 0;
  for (const candidate of COMBO_WEIGHTED_SCORES) {
    if (candidate <= score) count++;
    else break;
  }
  return count / COMBO_WEIGHTED_SCORES.length;
}

export function isSuitedConnector(a: Card, b: Card, maxGap = 1): boolean {
  return a.suit === b.suit && Math.abs(a.rank - b.rank) <= maxGap;
}

export function isSuitedAce(a: Card, b: Card): boolean {
  return a.suit === b.suit && (a.rank === 14 || b.rank === 14);
}
