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
 * Explicit cash-game *playability* ordering of all 169 starting-hand classes,
 * strongest first. It drives opening, defending and re-raising ranges, where
 * suitedness, connectivity and nut potential matter as much as raw equity.
 *
 * An additive formula cannot express this ordering: pairs must dominate the
 * top (AA > KK > QQ > JJ > AKs), while suited connectors must still outrank
 * dominated offsuit broadways further down. The previous formula ranked AKs
 * above AA and KQs above AKo/TT, which distorted every "top X%" threshold.
 */
export const PLAYABILITY_ORDER: readonly string[] = [
  'AA', 'KK', 'QQ', 'JJ', 'AKs', 'AKo', 'TT', 'AQs', 'AJs', 'KQs',
  '99', 'AQo', 'ATs', 'KJs', 'QJs', '88', 'KTs', 'AJo', 'JTs', '77',
  'QTs', 'A9s', 'KQo', 'ATo', '66', 'A8s', 'K9s', 'T9s', 'J9s', 'A5s',
  '55', 'A7s', 'Q9s', 'KJo', 'QJo', 'A4s', '98s', 'A6s', '44', 'A3s',
  'K8s', 'T8s', 'JTo', '87s', 'A2s', '33', 'J8s', 'Q8s', '22', 'K7s',
  '76s', '97s', 'KTo', 'QTo', 'A9o', '65s', 'K6s', 'T7s', '86s', '54s',
  'K5s', 'J7s', 'Q7s', 'A8o', '75s', 'K4s', '96s', 'K3s', 'Q6s', 'K2s',
  '64s', 'A7o', 'T9o', 'J9o', 'Q5s', '85s', 'J6s', 'Q4s', 'A5o', '53s',
  '74s', 'Q3s', 'T6s', 'J5s', 'A6o', 'K9o', 'A4o', 'Q2s', 'J4s', '95s',
  '43s', '63s', '98o', 'J3s', 'T5s', 'A3o', '84s', 'J2s', '87o', 'Q9o',
  'T4s', 'A2o', '73s', '52s', 'T8o', 'J8o', '76o', '42s', 'T3s', '94s',
  '62s', '65o', 'K8o', 'T2s', '32s', '93s', '83s', '54o', '97o', 'K7o',
  '92s', 'Q8o', '82s', '72s', '86o', 'K6o', 'J7o', '75o', 'K5o', '64o',
  'Q7o', 'K4o', 'T7o', 'K3o', '53o', 'Q6o', 'K2o', '96o', '85o', 'Q5o',
  '43o', 'J6o', 'Q4o', '74o', '63o', 'Q3o', 'T6o', 'J5o', 'Q2o', '95o',
  'J4o', '84o', '52o', 'J3o', 'T5o', '42o', '73o', 'J2o', 'T4o', '32o',
  '94o', '62o', 'T3o', '83o', '93o', 'T2o', '82o', '92o', '72o',
];

const PLAYABILITY_RANK = new Map<string, number>(
  PLAYABILITY_ORDER.map((hand, index) => [hand, index]),
);

/**
 * Playability score (higher is stronger). Distinct hand classes never tie, so
 * every "top X% of combos" threshold maps to an unambiguous set of hands.
 */
export function preflopScore(a: Card, b: Card): number {
  const rank = PLAYABILITY_RANK.get(startingHandClass(a, b));
  if (rank === undefined) throw new Error(`Unknown starting hand ${startingHandClass(a, b)}`);
  return PLAYABILITY_ORDER.length - rank;
}

/**
 * All-in strength (higher is stronger), approximating hot-and-cold equity
 * against a random hand. Pairs and high cards dominate; suitedness and
 * connectivity add little because there are no implied odds once the money is
 * in. This orders shove/re-shove ranges; it must not be used for opening or
 * defending ranges, where playability matters.
 */
export function preflopAllInScore(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  if (hi === lo) return 52 + hi * 2.9;
  const gap = hi - lo;
  return (
    30 +
    hi * 1.9 +
    lo * 1.0 +
    (gap === 1 ? 1 : gap === 2 ? 0.5 : 0) +
    (a.suit === b.suit ? 2.5 : 0)
  );
}

type Scorer = (a: Card, b: Card) => number;

function comboWeightedScores(score: Scorer): number[] {
  const scores: number[] = [];
  for (let hi = 14; hi >= 2; hi--) {
    for (let lo = hi; lo >= 2; lo--) {
      if (hi === lo) {
        const a = { rank: hi as Rank, suit: 's' as const };
        const b = { rank: lo as Rank, suit: 'h' as const };
        for (let i = 0; i < 6; i++) scores.push(score(a, b));
      } else {
        const suitedA = { rank: hi as Rank, suit: 's' as const };
        const suitedB = { rank: lo as Rank, suit: 's' as const };
        const offB = { rank: lo as Rank, suit: 'h' as const };
        for (let i = 0; i < 4; i++) scores.push(score(suitedA, suitedB));
        for (let i = 0; i < 12; i++) scores.push(score(suitedA, offB));
      }
    }
  }
  return scores.sort((x, y) => x - y);
}

const PLAYABILITY_COMBO_SCORES = comboWeightedScores(preflopScore);
const ALL_IN_COMBO_SCORES = comboWeightedScores(preflopAllInScore);

function percentileOf(score: number, sortedScores: number[]): number {
  let count = 0;
  for (const candidate of sortedScores) {
    if (candidate <= score) count++;
    else break;
  }
  return count / sortedScores.length;
}

/**
 * Combo-weighted playability percentile among all 1,326 starting combinations.
 * 1 is strongest. Unlike a 169-cell percentile, pairs/suited/offsuit classes
 * carry their real 6/4/12 combination weights.
 */
export function preflopPercentile(a: Card, b: Card): number {
  return percentileOf(preflopScore(a, b), PLAYABILITY_COMBO_SCORES);
}

/** Combo-weighted all-in percentile (1 is strongest). */
export function preflopAllInPercentile(a: Card, b: Card): number {
  return percentileOf(preflopAllInScore(a, b), ALL_IN_COMBO_SCORES);
}

export function isSuitedConnector(a: Card, b: Card, maxGap = 1): boolean {
  return a.suit === b.suit && Math.abs(a.rank - b.rank) <= maxGap;
}

export function isSuitedAce(a: Card, b: Card): boolean {
  return a.suit === b.suit && (a.rank === 14 || b.rank === 14);
}
