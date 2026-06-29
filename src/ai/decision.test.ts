import { describe, it, expect } from 'vitest';
import { decide } from './decision';
import { generatePersonality } from './personality';
import { dynamicBluffFrequency } from './dynamicBluff';
import type { DecisionContext, Personality } from './types';
import { parseCards } from '../engine/deck';
import type { Card } from '../engine/types';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tag: Personality = {
  vpip: 0.25,
  pfr: 0.7,
  aggression: 0.7,
  bluff: 0.25,
  callDown: 0.4,
  positionAwareness: 0.7,
  stackReactivity: 0.6,
  potReactivity: 0.6,
};

function ctx(partial: Partial<DecisionContext> & { hole: [Card, Card] }): DecisionContext {
  return {
    board: [],
    liveOpponents: 1,
    potBefore: 3,
    toCall: 2,
    stack: 200,
    bigBlind: 2,
    positionFactor: 0.5,
    street: 'preflop',
    canCheck: false,
    minRaiseTo: 4,
    maxRaiseTo: 200,
    streetCommitted: 0,
    recentImage: 0,
    ...partial,
  };
}

describe('decide - sane baselines', () => {
  it('raises or calls with pocket aces preflop', () => {
    const d = decide({
      personality: tag,
      difficulty: 'medium',
      ctx: ctx({ hole: parseCards('As Ad') as [Card, Card] }),
      rng: seeded(1),
      iterations: 400,
    });
    expect(['raise', 'allin', 'call']).toContain(d.action);
  });

  it('folds 7-2 offsuit to a raise as a tight player', () => {
    const folds = [];
    for (let s = 0; s < 8; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'medium',
        ctx: ctx({
          hole: parseCards('7s 2d') as [Card, Card],
          toCall: 12,
          potBefore: 18,
        }),
        rng: seeded(s + 10),
        iterations: 300,
      });
      folds.push(d.action);
    }
    // Should mostly fold; at least a clear majority.
    const foldCount = folds.filter((a) => a === 'fold').length;
    expect(foldCount).toBeGreaterThanOrEqual(5);
  });

  it('can check back when no bet is faced and hand is weak', () => {
    const d = decide({
      personality: { ...tag, aggression: 0.2, bluff: 0.0 },
      difficulty: 'medium',
      ctx: ctx({
        hole: parseCards('7s 2d') as [Card, Card],
        board: parseCards('Ah Kd Qc'),
        street: 'flop',
        toCall: 0,
        canCheck: true,
        potBefore: 10,
      }),
      rng: seeded(3),
      iterations: 300,
    });
    expect(['check', 'fold']).toContain(d.action);
  });

  it('produces a positive thinking delay', () => {
    const d = decide({
      personality: tag,
      difficulty: 'medium',
      ctx: ctx({ hole: parseCards('Ks Kd') as [Card, Card] }),
      rng: seeded(5),
      iterations: 200,
    });
    expect(d.thinkMs).toBeGreaterThan(0);
  });
});

describe('dynamicBluffFrequency', () => {
  const base = ctx({ hole: parseCards('7s 2d') as [Card, Card], board: parseCards('2h 7d Kc'), street: 'flop' });

  it('bluffs more in late position', () => {
    const early = dynamicBluffFrequency(tag, { ...base, positionFactor: 0.1 });
    const late = dynamicBluffFrequency(tag, { ...base, positionFactor: 0.9 });
    expect(late).toBeGreaterThan(early);
  });

  it('bluffs less into more opponents', () => {
    const few = dynamicBluffFrequency(tag, { ...base, liveOpponents: 1 });
    const many = dynamicBluffFrequency(tag, { ...base, liveOpponents: 4 });
    expect(many).toBeLessThan(few);
  });

  it('bluffs less with an aggressive table image', () => {
    const fresh = dynamicBluffFrequency(tag, { ...base, recentImage: 0 });
    const aggro = dynamicBluffFrequency(tag, { ...base, recentImage: 1 });
    expect(aggro).toBeLessThan(fresh);
  });

  it('bluffs more on wet boards than dry ones', () => {
    const dry = dynamicBluffFrequency(tag, { ...base, board: parseCards('2h 7d Kc') });
    const wet = dynamicBluffFrequency(tag, { ...base, board: parseCards('9h 8h 7h') });
    expect(wet).toBeGreaterThan(dry);
  });
});

describe('decide - pot odds awareness (postflop)', () => {
  const board = parseCards('2h 7s Td');
  const hole = parseCards('Kd Qc') as [Card, Card]; // two overcards, marginal

  function foldRate(toCall: number, pot: number): number {
    let folds = 0;
    const n = 24;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'medium',
        ctx: ctx({ hole, board, street: 'flop', canCheck: false, toCall, potBefore: pot }),
        rng: seeded(s + 100),
        iterations: 200,
      });
      if (d.action === 'fold') folds++;
    }
    return folds / n;
  }

  it('folds far more often facing a big bet than a small one (same hand)', () => {
    const small = foldRate(4, 40); // pot odds ~9%
    const big = foldRate(60, 40); // pot odds ~60%
    expect(big).toBeGreaterThan(small + 0.2); // clear pot-odds sensitivity
    expect(small).toBeLessThan(0.4); // rarely folds when cheap
    expect(big).toBeGreaterThan(0.5); // often folds when expensive
  });
});

describe('decide - preflop ranges respond to looseness', () => {
  const hole = parseCards('Qs Ts') as [Card, Card]; // decent suited broadway

  function notFoldCount(vpip: number): number {
    const person: Personality = { ...tag, vpip, pfr: 0.5 };
    let plays = 0;
    for (let s = 0; s < 24; s++) {
      const d = decide({
        personality: person,
        difficulty: 'medium',
        ctx: ctx({ hole, toCall: 6, potBefore: 9, positionFactor: 0.5 }),
        rng: seeded(s + 200),
      });
      if (d.action !== 'fold') plays++;
    }
    return plays;
  }

  it('a loose player plays a marginal hand more than a tight player', () => {
    const loose = notFoldCount(0.7);
    const tight = notFoldCount(0.1);
    expect(loose).toBeGreaterThan(tight);
  });
});

describe('generatePersonality', () => {
  it('easy personalities have no position awareness and low bluff', () => {
    for (let s = 0; s < 6; s++) {
      const p = generatePersonality('easy', seeded(s + 1));
      expect(p.positionAwareness).toBe(0);
      expect(p.bluff).toBeLessThan(0.3);
    }
  });

  it('hard personalities are position-aware', () => {
    const p = generatePersonality('hard', seeded(42));
    expect(p.positionAwareness).toBeGreaterThan(0.5);
  });
});
