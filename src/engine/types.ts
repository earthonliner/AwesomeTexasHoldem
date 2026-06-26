/**
 * Core domain types shared across the engine, AI and UI layers.
 * Keep this module free of any runtime/UI dependency so it stays portable.
 */

export type Suit = 's' | 'h' | 'd' | 'c';

/** Rank value 2..14 where 14 = Ace. Stored numerically for fast comparison. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

/** Hand category ordered from weakest (0) to strongest (8). */
export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

/**
 * A fully evaluated 5-card hand.
 * `score` is a single comparable integer; higher always wins.
 * `tiebreakers` keeps the ordered rank list used for human-readable comparison.
 */
export interface HandRank {
  category: HandCategory;
  score: number;
  tiebreakers: Rank[];
  cards: Card[];
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface PlayerAction {
  type: ActionType;
  /** Total chips the player puts in for this action (the resulting wager level, not the delta). */
  amount: number;
}
