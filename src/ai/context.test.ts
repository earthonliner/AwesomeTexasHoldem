import { describe, expect, it } from 'vitest';
import { applyAction, startHand, type SeatInit } from '../engine/game';
import type { GameConfig } from '../engine/gameTypes';
import { buildDecisionContext, resolveProfiledOpponentId } from './context';

const config: GameConfig = {
  seatCount: 6,
  blindLevel: 1,
  startingStackBB: 100,
  difficulty: 'hard',
};

const seats: SeatInit[] = Array.from({ length: 6 }, (_, id) => ({
  id,
  name: `P${id}`,
  isHero: false,
  stack: 200,
}));

describe('buildDecisionContext', () => {
  it('identifies a profiled LAN human aggressor and the raised-pot state', () => {
    let game = startHand(config, seats, 0, 1, () => 0.42);
    expect(game.toAct).toBe(3); // UTG
    game = applyAction(game, { type: 'raise', amount: 6 });

    const ctx = buildDecisionContext(game, game.toAct, {
      profiledPlayerIds: new Set([3]),
    });
    expect(ctx.preflopPotType).toBe('singleRaised');
    expect(ctx.preflopRaiseCount).toBe(1);
    expect(ctx.aggressorIsHero).toBe(true);
    expect(ctx.profiledPlayerId).toBe(3);
    expect(ctx.betToPot).toBeGreaterThan(0);
  });
});

describe('resolveProfiledOpponentId', () => {
  it('uses a sole human fallback only in a heads-up pot', () => {
    expect(resolveProfiledOpponentId(undefined, 1, [7])).toBe(7);
    expect(resolveProfiledOpponentId(undefined, 2, [7])).toBeUndefined();
  });

  it('keeps an identified human aggressor in a multiway pot', () => {
    expect(resolveProfiledOpponentId(7, 3, [7, 9])).toBe(7);
  });
});
