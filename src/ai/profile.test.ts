import { describe, it, expect } from 'vitest';
import { emptyHeroProfile, updateHeroProfile, type HandSummary } from './profile';

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
    expect(p.foldToCbet).toBeCloseTo(2 / 3, 5);
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
    expect(p.bluffCaught).toBeCloseTo(1 / 3, 5);
  });
});
