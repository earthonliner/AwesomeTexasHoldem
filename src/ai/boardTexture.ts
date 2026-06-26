import type { Card } from '../engine/types';

/**
 * Estimate board "wetness" in 0..1 (dry = 0, very wet/draw-heavy = 1).
 * Considers flush potential, straight connectivity and pairing. Wet boards make
 * bluffs more credible (more draws to represent) but also more dangerous.
 */
export function boardWetness(board: Card[]): number {
  if (board.length < 3) return 0;

  const suits = new Map<string, number>();
  for (const c of board) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  const maxSuit = Math.max(...suits.values());
  const flushScore = maxSuit >= 3 ? 0.45 : maxSuit === 2 ? 0.2 : 0;

  const ranks = [...new Set(board.map((c) => c.rank))].sort((a, b) => a - b);
  let connectScore = 0;
  for (let i = 0; i < ranks.length - 1; i++) {
    const gap = ranks[i + 1] - ranks[i];
    if (gap === 1) connectScore += 0.18;
    else if (gap === 2) connectScore += 0.12;
    else if (gap === 3) connectScore += 0.06;
  }
  connectScore = Math.min(0.4, connectScore);

  const paired = board.length - new Set(board.map((c) => c.rank)).size > 0;
  const pairScore = paired ? 0.15 : 0;

  return Math.min(1, flushScore + connectScore + pairScore);
}
