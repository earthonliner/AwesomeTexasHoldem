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

export interface RangeEquityOptions {
  heroCards: [Card, Card];
  board?: Card[];
  opponents: number;
  iterations?: number;
  rng?: Rng;
  /**
   * Fraction (0..1) of the strongest hands — ranked by their made strength on the
   * *current* board — that each opponent is assumed to hold. Smaller = tighter.
   * This is the realistic model: opponents who are still in the pot (and betting)
   * hold far stronger-than-random ranges, so a marginal made hand has much less
   * equity than a naive "vs two random cards" estimate suggests.
   */
  rangeFraction: number;
}

export interface RangeEquityResult extends EquityResult {
  /** Number of two-card combos in the assumed opponent range. */
  rangeCombos: number;
}

/**
 * Equity vs an estimated opponent range. Opponents are sampled from the top
 * `rangeFraction` of hands ranked by their current strength on the board
 * (pre-flop: ranked by a pre-flop strength heuristic). This corrects the
 * over-optimism of "vs random" equity on the turn and river.
 */
export function estimateEquityVsRange(opts: RangeEquityOptions): RangeEquityResult {
  const { heroCards, board = [], opponents, iterations = 1500, rng = defaultRng } = opts;
  const rangeFraction = Math.min(1, Math.max(0.02, opts.rangeFraction));

  const known = [...heroCards, ...board];
  const remaining = removeKnown(makeDeck(), known);

  // Rank every possible opponent combo by strength given the current board.
  const combos: { cards: [Card, Card]; score: number }[] = [];
  for (let i = 0; i < remaining.length; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const a = remaining[i];
      const b = remaining[j];
      const score = board.length >= 3 ? evaluateHand([a, b, ...board]).score : preflopStrength(a, b);
      combos.push({ cards: [a, b], score });
    }
  }
  combos.sort((x, y) => y.score - x.score);

  // Keep at least enough combos to seat every opponent comfortably.
  const floor = Math.min(combos.length, Math.max(opponents * 6, 12));
  const wanted = Math.round(rangeFraction * combos.length);
  const allowedCount = Math.min(combos.length, Math.max(floor, wanted));
  const allowed = combos.slice(0, allowedCount).map((c) => c.cards);

  const needBoard = 5 - board.length;
  const knownIds = known.map(cardId);

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let equitySum = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const usedIds = new Set<number>(knownIds);
    const oppHands: [Card, Card][] = [];

    for (let o = 0; o < opponents; o++) {
      let placed: [Card, Card] | null = null;
      for (let attempt = 0; attempt < 16; attempt++) {
        const pick = allowed[Math.floor(rng() * allowed.length)];
        const id1 = cardId(pick[0]);
        const id2 = cardId(pick[1]);
        if (!usedIds.has(id1) && !usedIds.has(id2)) {
          usedIds.add(id1);
          usedIds.add(id2);
          placed = pick;
          break;
        }
      }
      if (!placed) {
        // Fallback: any two unused cards (keeps the simulation unbiased rather
        // than dropping iterations when the range is depleted by collisions).
        const pool = remaining.filter((c) => !usedIds.has(cardId(c)));
        const a = pool[Math.floor(rng() * pool.length)];
        const b = pool.filter((c) => cardId(c) !== cardId(a))[Math.floor(rng() * (pool.length - 1))];
        usedIds.add(cardId(a));
        usedIds.add(cardId(b));
        placed = [a, b];
      }
      oppHands.push(placed);
    }

    const pool = remaining.filter((c) => !usedIds.has(cardId(c)));
    shuffle(pool, rng);
    const fullBoard = board.concat(pool.slice(0, needBoard));

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
    rangeCombos: allowedCount,
  };
}

/**
 * Choose a realistic opponent range fraction for the hero's spot. Tighter when
 * facing a bet (and a bigger bet), and as streets progress; looser in unraised
 * pots. Returned value feeds `estimateEquityVsRange`.
 */
export function estimateRangeFraction(args: {
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  facingBet: boolean;
  toCall: number;
  pot: number;
}): number {
  const { street, facingBet, toCall, pot } = args;
  let fraction = facingBet ? 0.38 : 0.62;

  // Bigger bets relative to the pot represent stronger, more polarized ranges.
  if (facingBet && pot > 0) {
    const betRatio = Math.min(2, toCall / pot);
    fraction -= Math.min(0.18, betRatio * 0.12);
  }

  // Ranges narrow as more money goes in on later streets.
  if (street === 'turn') fraction -= 0.04;
  if (street === 'river') fraction -= 0.08;

  return Math.min(0.85, Math.max(0.12, fraction));
}
