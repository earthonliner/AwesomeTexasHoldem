import { describe, it, expect } from 'vitest';
import { reviewDecision } from './review';
import type { DecisionSnapshot } from '../store/types';

function snap(partial: Partial<DecisionSnapshot>): DecisionSnapshot {
  return {
    street: 'flop',
    board: [],
    potBefore: 10,
    toCall: 4,
    equity: 0.3,
    win: 0.3,
    tie: 0,
    potOdds: 4 / 14,
    rangeFraction: 0.4,
    iterations: 1000,
    liveOpponents: 1,
    evCall: 0,
    evFold: 0,
    evRaiseHint: 0,
    chosen: 'call',
    chosenAmount: 0,
    ...partial,
  };
}

describe('reviewDecision', () => {
  it('rates a fold as reasonable when calling is clearly -EV', () => {
    const r = reviewDecision(snap({ chosen: 'fold', evCall: -6, evRaiseHint: -10, equity: 0.12, toCall: 8 }));
    expect(r.verdict).toBe('good');
    expect(r.bestAction).toBe('fold');
  });

  it('flags folding a clearly +EV spot as a mistake', () => {
    const r = reviewDecision(snap({ chosen: 'fold', evCall: 12, evRaiseHint: 6, equity: 0.7 }));
    expect(r.verdict).toBe('bad');
    expect(r.bestAction).toBe('call');
    expect(r.comment).toContain('偏紧');
  });

  it('rates a call matching the best line as reasonable', () => {
    const r = reviewDecision(snap({ chosen: 'call', evCall: 8, evRaiseHint: 7, evFold: 0, equity: 0.55 }));
    expect(r.verdict).toBe('good');
  });

  it('classifies an aggressive bet with low equity as a bluff comment', () => {
    const r = reviewDecision(
      snap({ chosen: 'bet', toCall: 0, evCall: 1, evRaiseHint: -3, evFold: 0, equity: 0.2 }),
    );
    expect(r.comment.length).toBeGreaterThan(0);
  });

  it('produces a non-negative EV gap', () => {
    const r = reviewDecision(snap({ chosen: 'call', evCall: 3, evRaiseHint: 9, evFold: 0 }));
    expect(r.gapBB).toBeGreaterThanOrEqual(0);
    expect(r.bestAction).toBe('raise');
  });
});
