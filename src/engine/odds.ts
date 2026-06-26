import type { Card } from './types';
import { makeDeck, cardId } from './deck';
import { evaluateHand } from './handEvaluator';

/**
 * Count outs: cards remaining in the deck that strictly improve the hero's best
 * 5-card hand category (a practical definition that matches how players count).
 * Works post-flop (board length 3 or 4).
 */
export function countOuts(heroCards: Card[], board: Card[]): { outs: number; cards: Card[] } {
  const known = [...heroCards, ...board];
  const knownIds = new Set(known.map(cardId));
  const remaining = makeDeck().filter((c) => !knownIds.has(cardId(c)));

  const current = evaluateHand([...heroCards, ...board]);
  const outCards: Card[] = [];

  for (const card of remaining) {
    const improved = evaluateHand([...heroCards, ...board, card]);
    if (improved.category > current.category) {
      outCards.push(card);
    }
  }
  return { outs: outCards.length, cards: outCards };
}

/** Probability of hitting at least one out by the river, given remaining streets. */
export function hitProbability(outs: number, cardsToCome: 1 | 2): number {
  // Unseen cards: 52 - 2 hole - board. We approximate using standard counts.
  const unseen = cardsToCome === 2 ? 47 : 46;
  if (cardsToCome === 1) {
    return outs / unseen;
  }
  // Two cards to come: 1 - P(miss both).
  const missTurn = (47 - outs) / 47;
  const missRiver = (46 - outs) / 46;
  return 1 - missTurn * missRiver;
}

/** Pot odds as the fraction of the final pot you must contribute to call. */
export function potOdds(potBeforeCall: number, callAmount: number): number {
  if (callAmount <= 0) return 0;
  return callAmount / (potBeforeCall + callAmount);
}

/**
 * Required equity to break even on a call, expressed as a probability.
 * Equal to pot odds; a call is +EV when your win probability exceeds this.
 */
export function requiredEquity(potBeforeCall: number, callAmount: number): number {
  return potOdds(potBeforeCall, callAmount);
}

/**
 * Implied odds: extra chips you expect to win on later streets when you hit.
 * Returns the break-even equity accounting for expected future winnings.
 */
export function impliedRequiredEquity(
  potBeforeCall: number,
  callAmount: number,
  expectedFutureWin: number,
): number {
  const denom = potBeforeCall + callAmount + expectedFutureWin;
  if (denom <= 0) return 0;
  return callAmount / denom;
}

/** EV of a call: equity-weighted pot minus the call cost. */
export function callEV(equity: number, potBeforeCall: number, callAmount: number): number {
  return equity * (potBeforeCall + callAmount) - (1 - equity) * callAmount;
}
