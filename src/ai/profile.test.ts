import { describe, it, expect } from 'vitest';
import {
  emptyHeroProfile,
  summarizePlayerHand,
  updateHeroProfile,
  type HandSummary,
} from './profile';
import { parseCards } from '../engine/deck';
import type { GameState } from '../engine/gameTypes';

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
});
