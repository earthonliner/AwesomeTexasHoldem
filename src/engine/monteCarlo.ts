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
  /**
   * Fraction (0..1) of the opponent's *betting* range that is a bluff (a weak /
   * busted hand). Real bettors are polarized: strong value hands AND bluffs. With
   * `bluffShare > 0` a portion of the modelled opponents are drawn from the weak
   * tail instead of the value top, so a bluff-catcher gets realistic equity
   * (it beats the bluffs) instead of ~0% against a value-only range.
   */
  bluffShare?: number;
  /**
   * How many of the opponents are passive CALLERS rather than the bettor.
   * Callers hold a capped range — decent hands below the raising range (their
   * strongest holdings would have raised) — which matters multiway.
   */
  cappedCallers?: number;
}

export interface RangeEquityResult extends EquityResult {
  /** Number of two-card combos in the assumed value range. */
  rangeCombos: number;
}

/**
 * Equity vs an estimated opponent range. Opponents are sampled from the top
 * `rangeFraction` of hands ranked by their current strength on the board
 * (pre-flop: ranked by a pre-flop strength heuristic). When `bluffShare > 0` the
 * range is polarized: that fraction of opponents instead holds a weak/bluff hand
 * from the bottom of the ranking — modelling that bettors also bluff.
 */
export function estimateEquityVsRange(opts: RangeEquityOptions): RangeEquityResult {
  const { heroCards, board = [], opponents, iterations = 1500, rng = defaultRng } = opts;
  const rangeFraction = Math.min(1, Math.max(0.02, opts.rangeFraction));
  const bluffShare = Math.min(0.9, Math.max(0, opts.bluffShare ?? 0));

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

  // Value range: the strongest `rangeFraction` of combos.
  const floor = Math.min(combos.length, Math.max(opponents * 6, 12));
  const wanted = Math.round(rangeFraction * combos.length);
  const valueCount = Math.min(combos.length, Math.max(floor, wanted));
  const valuePool = combos.slice(0, valueCount).map((c) => c.cards);

  // Bluff range: the weakest combos (busted draws / air) the opponent might bet.
  let bluffPool: [Card, Card][] = [];
  if (bluffShare > 0) {
    const bluffCount = Math.min(combos.length, Math.max(opponents * 6, Math.round(0.4 * combos.length)));
    bluffPool = combos.slice(combos.length - bluffCount).map((c) => c.cards);
  }

  // Caller range: capped just below the raising range (their nut combos would
  // have raised, so callers hold medium-strength hands).
  const cappedCallers = Math.min(Math.max(0, opts.cappedCallers ?? 0), Math.max(0, opponents - 1));
  let callerPool: [Card, Card][] = [];
  if (cappedCallers > 0) {
    const span = Math.max(opponents * 6, Math.round(0.35 * combos.length));
    callerPool = combos.slice(valueCount, Math.min(combos.length, valueCount + span)).map((c) => c.cards);
    if (callerPool.length === 0) callerPool = valuePool;
  }

  const needBoard = 5 - board.length;
  const knownIds = known.map(cardId);

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let equitySum = 0;

  const drawFrom = (pool: [Card, Card][], usedIds: Set<number>): [Card, Card] => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const pick = pool[Math.floor(rng() * pool.length)];
      const id1 = cardId(pick[0]);
      const id2 = cardId(pick[1]);
      if (!usedIds.has(id1) && !usedIds.has(id2)) {
        usedIds.add(id1);
        usedIds.add(id2);
        return pick;
      }
    }
    // Fallback: any two unused cards (avoid dropping iterations on collisions).
    const free = remaining.filter((c) => !usedIds.has(cardId(c)));
    const a = free[Math.floor(rng() * free.length)];
    const b = free.filter((c) => cardId(c) !== cardId(a))[Math.floor(rng() * (free.length - 1))];
    usedIds.add(cardId(a));
    usedIds.add(cardId(b));
    return [a, b];
  };

  for (let iter = 0; iter < iterations; iter++) {
    const usedIds = new Set<number>(knownIds);
    const oppHands: [Card, Card][] = [];

    for (let o = 0; o < opponents; o++) {
      // The last `cappedCallers` opponents are passive callers with capped ranges.
      if (o >= opponents - cappedCallers) {
        oppHands.push(drawFrom(callerPool, usedIds));
        continue;
      }
      const useBluff = bluffShare > 0 && bluffPool.length > 0 && rng() < bluffShare;
      oppHands.push(drawFrom(useBluff ? bluffPool : valuePool, usedIds));
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
    rangeCombos: valueCount,
  };
}

/**
 * Estimate how much of an opponent's *betting* range is bluffs, for the hero's
 * analysis. Heads-up bettors are quite polarized (≈ a third bluffs); multiway
 * betting is far more value-heavy, so bluffs shrink with more opponents. Wetter
 * boards (more busted draws) carry slightly more bluffs.
 */
export function estimateBluffShare(args: {
  facingBet: boolean;
  liveOpponents: number;
  wetness: number;
}): number {
  if (!args.facingBet) return 0;
  const base = 0.34 + args.wetness * 0.12;
  const multiwayDamp = Math.sqrt(Math.max(1, args.liveOpponents));
  return Math.min(0.5, Math.max(0.08, base / multiwayDamp));
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
