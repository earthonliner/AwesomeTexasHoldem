import type { Card, Rank } from './types';
import { HandCategory } from './types';

/**
 * Encode a hand as a single base-15 integer so two hands can be compared with a
 * plain numeric `<`. Layout: [category][t0][t1][t2][t3][t4], each tiebreaker a
 * rank in 2..14 (well within a base-15 digit). Using 15 keeps the math exact in
 * JS doubles: 8 * 15^5 ≈ 6.07M, far below Number.MAX_SAFE_INTEGER.
 */
function encodeScore(category: HandCategory, tiebreakers: Rank[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * 15 + (tiebreakers[i] ?? 0);
  }
  return score;
}

interface CategoryResult {
  category: HandCategory;
  tiebreakers: Rank[];
  cards: Card[];
}

/** Detect a straight given a descending-unique rank list; returns the high card. */
function findStraightHigh(uniqueDescRanks: Rank[]): Rank | null {
  // Treat Ace as low (value 1) for the wheel A-2-3-4-5.
  const ranks = [...uniqueDescRanks];
  if (ranks.includes(14)) ranks.push(1 as Rank);

  let run = 1;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1] - 1) {
      run += 1;
      if (run >= 5) return (ranks[i] + 4) as Rank;
    } else if (ranks[i] !== ranks[i - 1]) {
      run = 1;
    }
  }
  return null;
}

/**
 * Evaluate the best 5-card hand out of 5..7 cards.
 * Pure function: never mutates the input array.
 */
export function evaluateHand(cards: Card[]): {
  category: HandCategory;
  score: number;
  tiebreakers: Rank[];
  cards: Card[];
} {
  if (cards.length < 5) {
    throw new Error(`evaluateHand needs at least 5 cards, got ${cards.length}`);
  }

  const result = classify(cards);
  return {
    category: result.category,
    score: encodeScore(result.category, result.tiebreakers),
    tiebreakers: result.tiebreakers,
    cards: result.cards,
  };
}

function classify(cards: Card[]): CategoryResult {
  // Group by suit for flush detection.
  const bySuit: Record<string, Card[]> = { s: [], h: [], d: [], c: [] };
  for (const card of cards) bySuit[card.suit].push(card);

  // Count rank multiplicities.
  const rankCount = new Map<Rank, number>();
  for (const card of cards) rankCount.set(card.rank, (rankCount.get(card.rank) ?? 0) + 1);

  const distinctRanksDesc = [...rankCount.keys()].sort((a, b) => b - a);

  // --- Straight flush (incl. royal) ---
  const flushSuit = (Object.keys(bySuit) as (keyof typeof bySuit)[]).find(
    (s) => bySuit[s].length >= 5,
  );
  if (flushSuit) {
    const flushCards = bySuit[flushSuit];
    const flushRanksDesc = [...new Set(flushCards.map((c) => c.rank))].sort((a, b) => b - a);
    const sfHigh = findStraightHigh(flushRanksDesc);
    if (sfHigh !== null) {
      return {
        category: HandCategory.StraightFlush,
        tiebreakers: [sfHigh],
        cards: pickStraightCards(flushCards, sfHigh),
      };
    }
  }

  // Build (rank, count) pairs sorted by count desc then rank desc.
  const groups = [...rankCount.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });

  // --- Four of a kind ---
  if (groups[0][1] === 4) {
    const quad = groups[0][0];
    const kicker = distinctRanksDesc.find((r) => r !== quad)!;
    return {
      category: HandCategory.FourOfAKind,
      tiebreakers: [quad, kicker],
      cards: takeByRank(cards, [quad, quad, quad, quad, kicker]),
    };
  }

  // --- Full house (also covers trips + trips, and trips + pair) ---
  if (groups[0][1] === 3) {
    const trips = groups[0][0];
    const pairCandidate = groups.find((g, idx) => idx > 0 && g[1] >= 2);
    if (pairCandidate) {
      const pair = pairCandidate[0];
      return {
        category: HandCategory.FullHouse,
        tiebreakers: [trips, pair],
        cards: takeByRank(cards, [trips, trips, trips, pair, pair]),
      };
    }
  }

  // --- Flush ---
  if (flushSuit) {
    const flushTop5 = bySuit[flushSuit]
      .map((c) => c.rank)
      .sort((a, b) => b - a)
      .slice(0, 5) as Rank[];
    return {
      category: HandCategory.Flush,
      tiebreakers: flushTop5,
      cards: bySuit[flushSuit]
        .slice()
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 5),
    };
  }

  // --- Straight ---
  const straightHigh = findStraightHigh(distinctRanksDesc);
  if (straightHigh !== null) {
    return {
      category: HandCategory.Straight,
      tiebreakers: [straightHigh],
      cards: pickStraightCards(cards, straightHigh),
    };
  }

  // --- Three of a kind ---
  if (groups[0][1] === 3) {
    const trips = groups[0][0];
    const kickers = distinctRanksDesc.filter((r) => r !== trips).slice(0, 2);
    return {
      category: HandCategory.ThreeOfAKind,
      tiebreakers: [trips, ...kickers],
      cards: takeByRank(cards, [trips, trips, trips, ...kickers]),
    };
  }

  // --- Two pair ---
  const pairs = groups.filter((g) => g[1] === 2).map((g) => g[0]);
  if (pairs.length >= 2) {
    const [hi, lo] = pairs.slice(0, 2);
    const kicker = distinctRanksDesc.find((r) => r !== hi && r !== lo)!;
    return {
      category: HandCategory.TwoPair,
      tiebreakers: [hi, lo, kicker],
      cards: takeByRank(cards, [hi, hi, lo, lo, kicker]),
    };
  }

  // --- One pair ---
  if (pairs.length === 1) {
    const pair = pairs[0];
    const kickers = distinctRanksDesc.filter((r) => r !== pair).slice(0, 3);
    return {
      category: HandCategory.Pair,
      tiebreakers: [pair, ...kickers],
      cards: takeByRank(cards, [pair, pair, ...kickers]),
    };
  }

  // --- High card ---
  const top5 = distinctRanksDesc.slice(0, 5);
  return {
    category: HandCategory.HighCard,
    tiebreakers: top5,
    cards: takeByRank(cards, top5),
  };
}

/** Collect actual Card objects for an ordered multiset of ranks. */
function takeByRank(cards: Card[], ranks: Rank[]): Card[] {
  const pool = [...cards];
  const out: Card[] = [];
  for (const r of ranks) {
    const idx = pool.findIndex((c) => c.rank === r);
    if (idx >= 0) out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** Collect the five cards forming a straight ending at `high`. */
function pickStraightCards(cards: Card[], high: Rank): Card[] {
  const wanted: Rank[] = [];
  for (let i = 0; i < 5; i++) {
    let r = high - i;
    if (r === 1) r = 14; // wheel ace
    wanted.push(r as Rank);
  }
  const out: Card[] = [];
  for (const r of wanted) {
    const card = cards.find((c) => c.rank === r);
    if (card) out.push(card);
  }
  return out;
}

/** Compare two card sets; >0 if a wins, <0 if b wins, 0 if tie. */
export function compareHands(a: Card[], b: Card[]): number {
  return evaluateHand(a).score - evaluateHand(b).score;
}

export const CATEGORY_LABEL: Record<HandCategory, string> = {
  [HandCategory.HighCard]: '高牌',
  [HandCategory.Pair]: '一对',
  [HandCategory.TwoPair]: '两对',
  [HandCategory.ThreeOfAKind]: '三条',
  [HandCategory.Straight]: '顺子',
  [HandCategory.Flush]: '同花',
  [HandCategory.FullHouse]: '葫芦',
  [HandCategory.FourOfAKind]: '四条',
  [HandCategory.StraightFlush]: '同花顺',
};
