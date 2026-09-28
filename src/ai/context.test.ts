import { describe, expect, it } from 'vitest';
import { applyAction, startHand, type SeatInit } from '../engine/game';
import { BB_CHIPS, type GameConfig, type GameState } from '../engine/gameTypes';
import type { ActionType } from '../engine/types';
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

  it('keeps the pre-flop raiser seat and roles after the table folds', () => {
    let game = startHand(config, seats, 0, 1, () => 0.42);
    // button = 0, SB = 1, BB = 2, UTG = 3
    game = applyAction(game, { type: 'raise', amount: 6 });
    while (game.toAct !== 2) game = applyAction(game, { type: 'fold', amount: 0 });

    const bbPreflop = buildDecisionContext(game, 2);
    expect(bbPreflop.aggressorPositionFactor).toBe(1); // live order: UTG acts last
    expect(bbPreflop.aggressorPosition).toBe('early');

    game = applyAction(game, { type: 'call', amount: 0 });
    expect(game.street).toBe('flop');
    const bbFlop = buildDecisionContext(game, 2);
    expect(bbFlop.preflopAggressorPosition).toBe('early');
    expect(bbFlop.rangeOpponentPosition).toBe('early');
    expect(bbFlop.rangeOpponentRaisedPreflop).toBe(true);

    const openerFlop = buildDecisionContext(game, 3);
    expect(openerFlop.rangeOpponentPosition).toBe('bb');
    expect(openerFlop.rangeOpponentRaisedPreflop).toBe(false);
  });

  it('does not relabel an earlier bettor as unacted after a full raise', () => {
    let game = startHand(
      { ...config, seatCount: 3 },
      seats.slice(0, 3),
      0,
      2,
      () => 0.37,
    );
    while (game.street === 'preflop') {
      const player = game.players[game.toAct];
      const toCall = game.currentBet - player.streetCommitted;
      game = applyAction(
        game,
        toCall > 0
          ? { type: 'call', amount: 0 }
          : { type: 'check', amount: 0 },
      );
    }

    game = applyAction(game, { type: 'bet', amount: 4 });
    game = applyAction(game, { type: 'raise', amount: 12 });
    expect(game.players[1].hasActed).toBe(false); // reset by the full raise
    expect(game.toAct).toBe(0);

    const ctx = buildDecisionContext(game, game.toAct);
    expect(ctx.playersBehind).toBe(0);
    expect(ctx.streetAggressionCount).toBe(2);
  });
});

describe('buildDecisionContext with all-in opponents', () => {
  const bb = BB_CHIPS;
  const play = (game: GameState, ...actions: [ActionType, number?][]) =>
    actions.reduce((g, [type, amount = 0]) => applyAction(g, { type, amount }), game);

  // Button X, small blind S (20bb), big blind A (100bb), UTG D (150bb).
  const shoveCalledTwice = () => {
    const table: SeatInit[] = [
      { id: 0, name: 'S', isHero: false, stack: 20 * bb },
      { id: 1, name: 'A', isHero: false, stack: 100 * bb },
      { id: 2, name: 'D', isHero: false, stack: 150 * bb },
      { id: 3, name: 'X', isHero: false, stack: 100 * bb },
    ];
    const game = startHand({ ...config, seatCount: 4 }, table, 3, 1, () => 0.42);
    // D limps, X folds, S shoves, A and D call.
    return play(game, ['call'], ['fold'], ['allin'], ['call'], ['call']);
  };

  it('measures the stack and position against the deep player, not the all-in raiser', () => {
    const game = shoveCalledTwice();
    expect(game.street).toBe('flop');
    expect(game.players[game.toAct].name).toBe('A');

    const ctx = buildDecisionContext(game, game.toAct);
    expect(ctx.villainWasAggressorLastStreet).toBe(true);
    expect(ctx.effectiveStack).toBe(80 * bb);
    expect(ctx.inPositionVsAggressor).toBe(false);
    expect(ctx.playersBehind).toBe(1);
    expect(ctx.rangeOpponentPosition).toBe(buildDecisionContext(game, 2).position);
    expect(ctx.winnablePot).toBe(60 * bb);
    expect(ctx.allIn).toEqual({
      opponents: 1,
      idle: 1,
      idleShare: 1,
      bettor: false,
      callers: 0,
      pot: 60 * bb,
      aggressor: true,
    });
  });

  it('splits the main pot from the side pot the live bettor builds', () => {
    const game = play(shoveCalledTwice(), ['check'], ['bet', 30 * bb]);
    const ctx = buildDecisionContext(game, game.toAct);
    expect(ctx.toCall).toBe(30 * bb);
    expect(ctx.winnablePot).toBe(120 * bb);
    expect(ctx.allIn).toMatchObject({ idle: 1, bettor: false, callers: 0, pot: 60 * bb, aggressor: false });
  });

  it('counts only the matched part of a bet when all-in for less', () => {
    const table: SeatInit[] = [
      { id: 0, name: 'B', isHero: false, stack: 100 * bb },
      { id: 1, name: 'S', isHero: false, stack: 25 * bb },
    ];
    const start = startHand({ ...config, seatCount: 2 }, table, 0, 1, () => 0.42);
    // The button opens to 15bb and is called, then bets 50bb into 30bb.
    const game = play(start, ['raise', 15 * bb], ['call'], ['check'], ['bet', 50 * bb]);
    const ctx = buildDecisionContext(game, game.toAct);
    expect(ctx.stack).toBe(10 * bb);
    expect(ctx.toCall).toBe(50 * bb);
    expect(ctx.winnablePot).toBe(50 * bb);
    expect(ctx.allIn).toBeUndefined();
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
