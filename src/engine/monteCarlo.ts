import type { Card } from './types';
import { makeDeck, shuffle, cardId, type Rng, defaultRng } from './deck';
import { evaluateHand } from './handEvaluator';

export interface EquityResult {
  /** Probability the hero strictly wins. */
  win: number;
  /** Probability of a split pot. */
  tie: number;
  /** Probability the hero loses. */
  lose: number;
  /** Combined equity = win + tie / (#players sharing) ≈ EV share of the pot. */
  equity: number;
  iterations: number;
}

export interface EquityOptions {
  heroCards: [Card, Card];
  board?: Card[];
  /** Number of opponents still in the hand. */
  opponents: number;
  iterations?: number;
  rng?: Rng;
  /**
   * Opponent range mode:
   *  - 'random': opponents hold two fully random cards.
   *  - 'range': opponents are weighted toward stronger holdings (a coarse model
   *    of a tightish range). Rejection-samples hands above a strength threshold.
   */
  mode?: 'random' | 'range';
}

function removeKnown(deck: Card[], known: Card[]): Card[] {
  const knownIds = new Set(known.map(cardId));
  return deck.filter((c) => !knownIds.has(cardId(c)));
}

/**
 * A cheap pre-flop hand-strength heuristic (0..1) used only to bias the 'range'
 * sampling mode toward plausible opponent holdings. Not used for evaluation.
 */
function preflopStrength(a: Card, b: Card): number {
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = hi - lo;

  let s = (hi + lo) / 28; // high-card weight
  if (pair) s += 0.35 + (hi - 2) * 0.02;
  if (suited) s += 0.06;
  if (!pair && gap <= 2) s += 0.05; // connectedness
  return Math.min(1, s);
}

/**
 * Monte Carlo equity estimation. Deals random opponent hands and runouts, then
 * tallies hero results. Deterministic when given a seeded `rng`.
 */
export function estimateEquity(opts: EquityOptions): EquityResult {
  const {
    heroCards,
    board = [],
    opponents,
    iterations = 5000,
    rng = defaultRng,
    mode = 'random',
  } = opts;

  const known = [...heroCards, ...board];
  const baseDeck = removeKnown(makeDeck(), known);
  const needBoard = 5 - board.length;

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let equitySum = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const deck = shuffle(baseDeck.slice(), rng);
    let cursor = 0;

    const oppHands: [Card, Card][] = [];
    for (let o = 0; o < opponents; o++) {
      let c1 = deck[cursor++];
      let c2 = deck[cursor++];

      if (mode === 'range') {
        // Rejection sampling: bias toward stronger hands but cap attempts so we
        // never loop forever when the deck is depleted.
        let attempts = 0;
        while (attempts < 4 && preflopStrength(c1, c2) < 0.3 + rng() * 0.3) {
          c1 = deck[cursor++ % deck.length];
          c2 = deck[cursor++ % deck.length];
          attempts++;
        }
      }
      oppHands.push([c1, c2]);
    }

    const fullBoard = board.concat(deck.slice(cursor, cursor + needBoard));

    const heroScore = evaluateHand([...heroCards, ...fullBoard]).score;
    let bestOpp = -Infinity;
    for (const oh of oppHands) {
      const s = evaluateHand([...oh, ...fullBoard]).score;
      if (s > bestOpp) bestOpp = s;
    }

    if (heroScore > bestOpp) {
      wins++;
      equitySum += 1;
    } else if (heroScore === bestOpp) {
      // Count how many opponents tie to compute the hero's pot share.
      let tieCount = 1;
      for (const oh of oppHands) {
        if (evaluateHand([...oh, ...fullBoard]).score === heroScore) tieCount++;
      }
      ties++;
      equitySum += 1 / tieCount;
    } else {
      losses++;
    }
  }

  return {
    win: wins / iterations,
    tie: ties / iterations,
    lose: losses / iterations,
    equity: equitySum / iterations,
    iterations,
  };
}
