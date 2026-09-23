import { describe, it, expect } from 'vitest';
import {
  emptyHeroProfile,
  summarizePlayerHand,
  updateHeroProfile,
  type HandSummary,
} from './profile';
import { applyAction, startHand, type SeatInit } from '../engine/game';
import { parseCards } from '../engine/deck';
import type { GameConfig, GameState } from '../engine/gameTypes';

function baseSummary(partial: Partial<HandSummary>): HandSummary {
  return {
    heroId: 0,
    actions: [],
    facedSteal: false,
    heroFoldedToSteal: false,
    heroReachedShowdown: false,
    ...partial,
  };
}

describe('updateHeroProfile — new exploit dimensions', () => {
  it('tracks fold-to-cbet rate', () => {
    let p = emptyHeroProfile();
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: true }));
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: true }));
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: false }));
    expect(p.counters.cbetFaced).toBe(3);
    expect(p.counters.cbetFolded).toBe(2);
    // Bayesian prior prevents three observations from creating an extreme read.
    expect(p.foldToCbet).toBeCloseTo(0.5625, 5);
  });

  it('tracks river honesty split by bet size (bluffCaught)', () => {
    let p = emptyHeroProfile();
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: true, weak: true } }));
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: true, weak: false } }));
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: false, weak: false } }));
    expect(p.counters.riverBetsShown).toBe(3);
    expect(p.counters.riverBigShown).toBe(2);
    expect(p.counters.riverBigWeak).toBe(1);
    expect(p.counters.riverSmallShown).toBe(1);
    expect(p.counters.riverSmallWeak).toBe(0);
    expect(p.bluffCaught).toBeCloseTo(0.3125, 5);
  });

  it('does not label a losing river value bet as a bluff', () => {
    const game = {
      players: [
        {
          id: 0,
          isHero: true,
          hole: parseCards('Ah Qd'),
          folded: false,
          sittingOut: false,
        },
        {
          id: 1,
          isHero: false,
          hole: parseCards('As Ks'),
          folded: false,
          sittingOut: false,
        },
      ],
      board: parseCards('Ac 8c 3d 6s 2h'),
      history: [
        {
          playerId: 0,
          street: 'river',
          type: 'bet',
          amount: 20,
          chipsPutIn: 20,
          raiseBy: 20,
          potBefore: 30,
          toCall: 0,
        },
      ],
      revealed: [0, 1],
      buttonIndex: 0,
      bigBlind: 2,
    } as GameState;

    expect(summarizePlayerHand(game, 0).riverBetShown).toEqual({
      big: true,
      weak: false,
    });
  });

  it('records a folded-to button open as a steal but not a limped-pot isolation', () => {
    const config: GameConfig = {
      seatCount: 6,
      blindLevel: 1,
      startingStackBB: 100,
      difficulty: 'hard',
    };
    const seats: SeatInit[] = Array.from({ length: 6 }, (_, id) => ({
      id,
      name: `P${id}`,
      isHero: id === 2,
      stack: 200,
    }));

    let unopened = startHand(config, seats, 0, 1, () => 0.42);
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'raise', amount: 6 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    expect(summarizePlayerHand(unopened, 2).facedSteal).toBe(true);

    let limped = startHand(config, seats, 0, 2, () => 0.42);
    limped = applyAction(limped, { type: 'call', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'raise', amount: 6 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    expect(summarizePlayerHand(limped, 2).facedSteal).toBe(false);
  });
});
