import type { Card } from './types';
import { evaluateHand } from './handEvaluator';

export interface PotContribution {
  playerId: number;
  /** Total chips this player has committed to the pot this hand. */
  contributed: number;
  /** Whether the player is still eligible to win (did not fold). */
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Players eligible to win this specific pot. */
  eligible: number[];
}

/**
 * Build the main pot and side pots from per-player contributions.
 *
 * Algorithm: repeatedly take the smallest non-zero contribution level. Every
 * player who put in at least that much contributes one "layer". Players who
 * folded still contribute their dead money but are not eligible to win.
 */
export function buildPots(contributions: PotContribution[]): Pot[] {
  const pots: Pot[] = [];
  // Work on a mutable copy of remaining contributions.
  const remaining = contributions.map((c) => ({ ...c }));

  while (true) {
    const positive = remaining.filter((c) => c.contributed > 0);
    if (positive.length === 0) break;

    const level = Math.min(...positive.map((c) => c.contributed));
    let amount = 0;
    const eligible: number[] = [];

    for (const c of remaining) {
      if (c.contributed > 0) {
        const take = Math.min(level, c.contributed);
        amount += take;
        c.contributed -= take;
        if (!c.folded) eligible.push(c.playerId);
      }
    }

    if (amount > 0) {
      // Merge with previous pot if eligibility is identical (keeps pot list tidy).
      const prev = pots[pots.length - 1];
      if (prev && sameEligibility(prev.eligible, eligible)) {
        prev.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
  }

  return pots;
}

function sameEligibility(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

export interface PlayerHand {
  playerId: number;
  /** 2 hole cards. Folded players may be omitted. */
  holeCards: Card[];
}

export interface Payout {
  playerId: number;
  amount: number;
}

/**
 * Distribute every pot to its winners by best 7-card hand.
 *
 * Odd chips that cannot be split evenly go to the eligible winner closest to the
 * left of the button (first to act in the order provided by `seatOrderFromButton`).
 *
 * @param pots                  pots from buildPots
 * @param hands                 hole cards per non-folded player
 * @param board                 community cards (0..5)
 * @param seatOrderFromButton   player ids ordered clockwise starting left of button
 */
export function distributePots(
  pots: Pot[],
  hands: PlayerHand[],
  board: Card[],
  seatOrderFromButton: number[],
): Payout[] {
  const payouts = new Map<number, number>();
  const handById = new Map<number, Card[]>();
  for (const h of hands) handById.set(h.playerId, h.holeCards);

  const add = (id: number, amt: number) => payouts.set(id, (payouts.get(id) ?? 0) + amt);

  for (const pot of pots) {
    const contenders = pot.eligible.filter((id) => handById.has(id));
    if (contenders.length === 0) continue;

    if (contenders.length === 1) {
      add(contenders[0], pot.amount);
      continue;
    }

    let bestScore = -Infinity;
    let winners: number[] = [];
    for (const id of contenders) {
      const score = evaluateHand([...handById.get(id)!, ...board]).score;
      if (score > bestScore) {
        bestScore = score;
        winners = [id];
      } else if (score === bestScore) {
        winners.push(id);
      }
    }

    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const id of winners) add(id, share);

    // Distribute odd chips one at a time starting left of the button.
    if (remainder > 0) {
      const ordered = seatOrderFromButton.filter((id) => winners.includes(id));
      let i = 0;
      while (remainder > 0 && ordered.length > 0) {
        add(ordered[i % ordered.length], 1);
        remainder -= 1;
        i += 1;
      }
    }
  }

  return [...payouts.entries()].map(([playerId, amount]) => ({ playerId, amount }));
}
