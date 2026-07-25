import { describe, it, expect } from 'vitest';
import { decide } from './decision';
import { generatePersonality } from './personality';
import { dynamicBluffFrequency } from './dynamicBluff';
import { emptyHeroProfile } from './profile';
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

describe('AI sizing realism (all-in discipline)', () => {
  const hole = parseCards('As Ad') as [Card, Card];
  const board = parseCards('Kh 7c 2d');
  const aggressive: Personality = { ...tag, aggression: 0.9, bluff: 0.4 };

  it('rarely shoves all-in with a deep stack', () => {
    let allins = 0;
    const n = 30;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: aggressive,
        difficulty: 'medium',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 10,
          potBefore: 20,
          stack: 400,
          streetCommitted: 0,
          minRaiseTo: 20,
          maxRaiseTo: 400,
        }),
        rng: seeded(s + 300),
        iterations: 150,
      });
      if (d.action === 'allin') allins++;
    }
    expect(allins).toBeLessThanOrEqual(2); // deep stacks don't spam jams
  });

  it('never open-jams a monster when deep (cash-game pot building)', () => {
    // Nut-ish hand, no bet to face, deep stack: real players bet, not shove.
    let allins = 0;
    const n = 30;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: aggressive,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('Ah Ad') as [Card, Card],
          board: parseCards('As 7c 2d'),
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 20,
          stack: 400,
          streetCommitted: 0,
          minRaiseTo: 4,
          maxRaiseTo: 400,
        }),
        rng: seeded(s + 500),
        iterations: 150,
      });
      if (d.action === 'allin') allins++;
    }
    expect(allins).toBe(0);
  });

  it('hard difficulty also avoids deep shoves facing a bet', () => {
    let allins = 0;
    const n = 30;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: aggressive,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 10,
          potBefore: 20,
          stack: 400,
          streetCommitted: 0,
          minRaiseTo: 20,
          maxRaiseTo: 400,
        }),
        rng: seeded(s + 600),
        iterations: 150,
      });
      if (d.action === 'allin') allins++;
    }
    expect(allins).toBe(0);
  });

  it('still shoves when short-stacked (low SPR commit)', () => {
    let allins = 0;
    const n = 30;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: aggressive,
        difficulty: 'medium',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 10,
          potBefore: 20,
          stack: 24,
          streetCommitted: 0,
          minRaiseTo: 20,
          maxRaiseTo: 24,
        }),
        rng: seeded(s + 400),
        iterations: 150,
      });
      if (d.action === 'allin') allins++;
    }
    expect(allins).toBeGreaterThan(0);
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

  it('medium personalities are uniformly balanced (no obvious over-bluffers)', () => {
    for (let s = 0; s < 25; s++) {
      const p = generatePersonality('medium', seeded(s + 1));
      expect(p.bluff).toBeLessThan(0.28); // no wild bluffers
      expect(p.bluff).toBeGreaterThan(0.05);
      expect(p.positionAwareness).toBeGreaterThan(0.6); // all skilled
    }
  });

  it('medium mixes TAG and LAG archetypes (both skilled styles present)', () => {
    let tagCount = 0;
    let lagCount = 0;
    for (let s = 0; s < 40; s++) {
      const p = generatePersonality('medium', seeded(s + 77));
      if (p.vpip >= 0.32) lagCount++;
      if (p.vpip <= 0.28) tagCount++;
    }
    expect(tagCount).toBeGreaterThan(8); // both archetypes clearly present
    expect(lagCount).toBeGreaterThan(8);
  });
});

describe('medium exploits the observed human style', () => {
  const trashHole = parseCards('9c 4d') as [Card, Card];

  function stealRaiseRate(withProfile: boolean): number {
    const profile = {
      ...emptyHeroProfile(),
      hands: 60,
      foldToSteal: 0.9,
    };
    let raises = 0;
    const n = 40;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'medium',
        ctx: ctx({
          hole: trashHole,
          toCall: 2,
          potBefore: 3,
          positionFactor: 0.95, // button
          street: 'preflop',
        }),
        rng: seeded(s + 900),
        heroProfile: withProfile ? profile : undefined,
      });
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    return raises / n;
  }

  it('steals the blinds more from a human who over-folds', () => {
    expect(stealRaiseRate(true)).toBeGreaterThan(stealRaiseRate(false));
  });
});

describe('medium AI bluffs in a controlled, hard-to-read way', () => {
  const hole = parseCards('7s 2d') as [Card, Card]; // air
  const board = parseCards('9h 8h 6c'); // wet

  function bluffRate(difficulty: 'medium' | 'hard'): number {
    let bets = 0;
    const n = 50;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: { ...tag, bluff: 0.25 },
        difficulty,
        ctx: ctx({ hole, board, street: 'flop', canCheck: true, toCall: 0, potBefore: 12 }),
        rng: seeded(s + 700),
        iterations: 120,
      });
      if (d.action !== 'check') bets++;
    }
    return bets / n;
  }

  it('does not over-bluff (bets a weak hand less than half the time) yet still bluffs sometimes', () => {
    const rate = bluffRate('medium');
    expect(rate).toBeLessThan(0.5);
    expect(rate).toBeGreaterThan(0);
  });

  it('bluffs no more often than hard difficulty in the same spot', () => {
    expect(bluffRate('medium')).toBeLessThanOrEqual(bluffRate('hard') + 0.05);
  });
});
