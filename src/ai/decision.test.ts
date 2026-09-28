import { describe, it, expect } from 'vitest';
import { buildDecisionContext } from './context';
import { actionEV, computeExploit, decide } from './decision';
import { generatePersonality } from './personality';
import { dynamicBluffFrequency } from './dynamicBluff';
import { emptyHeroProfile, RIVER_FOLD_PRIOR } from './profile';
import type { AIDecision, DecisionContext, HeroProfile, Personality } from './types';
import { parseCards, makeDeck, shuffle } from '../engine/deck';
import { applyAction, startHand, type SeatInit } from '../engine/game';
import { BB_CHIPS } from '../engine/gameTypes';
import type { ActionType, Card } from '../engine/types';

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
    totalCommitted: 0,
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

describe('EV-gated action selection (hard)', () => {
  it('never pays off a clearly negative-EV river bet with a hopeless hand', () => {
    // Bottom of the range facing a pot-sized river bet: calling loses ~one bet
    // per call. Randomisation belongs to near-indifferent spots only.
    const hole = parseCards('7c 2d') as [Card, Card];
    const board = parseCards('Ah Kd Qs Jc 9h');
    let calls = 0;
    for (let s = 0; s < 40; s++) {
      const d = decide({
        personality: { ...tag, callDown: 0.9 },
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board,
          street: 'river',
          canCheck: false,
          toCall: 40,
          potBefore: 80,
          positionFactor: 1,
          streetAggressionCount: 1,
          betToPot: 1,
        }),
        rng: seeded(9100 + s),
        iterations: 200,
      });
      if (d.action !== 'fold') calls++;
    }
    expect(calls).toBe(0);
  });

  it('fires a flop c-bet at one final frequency rather than a compounded one', () => {
    // Pre-flop raiser in position, checked to by one caller, pure air on a dry
    // board: the c-bet plan is the only roll, so the observed frequency must sit
    // inside the plan's own band (never the 1 - Π(1 - p_i) of stacked rolls).
    const hole = parseCards('7c 5d') as [Card, Card];
    const board = parseCards('Kh 8s 2d');
    let bets = 0;
    const n = 120;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 14,
          positionFactor: 1,
          wasAggressorLastStreet: true,
          inPositionVsAggressor: true,
          preflopRaised: true,
          preflopPotType: 'singleRaised',
        }),
        rng: seeded(9300 + s),
        iterations: 120,
      });
      if (d.action === 'raise') bets++;
    }
    const rate = bets / n;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.62);
  });
});

describe('decide - preflop ranges respond to looseness', () => {
  const hole = parseCards('Ah 5h') as [Card, Card]; // marginal blocker hand

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

describe('hard preflop expert strategy', () => {
  const expert: Personality = {
    ...tag,
    vpip: 0.27,
    pfr: 0.78,
    bluff: 0.19,
    positionAwareness: 0.92,
  };

  function rfiActions(hand: string, position: 'early' | 'btn', positionFactor: number) {
    const actions: string[] = [];
    for (let s = 0; s < 80; s++) {
      actions.push(
        decide({
          personality: expert,
          difficulty: 'hard',
          ctx: ctx({
            hole: parseCards(hand) as [Card, Card],
            position,
            tableSize: 6,
            positionFactor,
            preflopPotType: 'unopened',
            preflopRaiseCount: 0,
            currentBet: 2,
            canRaise: true,
          }),
          rng: seeded(10_000 + s),
        }).action,
      );
    }
    return actions;
  }

  it('uses raise-or-fold outside the small blind instead of accidental open limps', () => {
    for (const hand of ['2s 2d', '6s 5s', 'Ks Td']) {
      expect(rfiActions(hand, 'btn', 1)).not.toContain('call');
    }
  });

  it('opens small pairs/connectors on the button but folds KTo from early position', () => {
    const button22 = rfiActions('2s 2d', 'btn', 1).filter((a) => a === 'raise').length;
    const button65s = rfiActions('6s 5s', 'btn', 1).filter((a) => a === 'raise').length;
    const earlyKTo = rfiActions('Ks Td', 'early', 0.4).filter((a) => a === 'fold').length;
    expect(button22).toBeGreaterThan(60);
    expect(button65s).toBeGreaterThan(45);
    expect(earlyKTo).toBeGreaterThan(60);
  });

  it('open-jams a 10bb button stack with A5o but folds it from early position', () => {
    const jamActions = (hand: string, position: 'early' | 'btn', liveOpponents: number) => {
      const actions: string[] = [];
      for (let s = 0; s < 30; s++) {
        actions.push(
          decide({
            personality: expert,
            difficulty: 'hard',
            ctx: ctx({
              hole: parseCards(hand) as [Card, Card],
              position,
              tableSize: 6,
              positionFactor: position === 'btn' ? 1 : 0.1,
              liveOpponents,
              playersBehind: liveOpponents,
              stack: 20,
              effectiveStack: 20,
              maxRaiseTo: 20,
              preflopPotType: 'unopened',
              preflopRaiseCount: 0,
              currentBet: 2,
              canRaise: true,
            }),
            rng: seeded(12_000 + s),
          }).action,
        );
      }
      return actions;
    };
    expect(jamActions('Ah 5d', 'btn', 2)).toEqual(Array(30).fill('allin'));
    expect(jamActions('7h 2d', 'btn', 2)).toEqual(Array(30).fill('fold'));
    expect(jamActions('Ah 5d', 'early', 5)).toEqual(Array(30).fill('fold'));
    expect(jamActions('Ah Jd', 'early', 5)).toEqual(Array(30).fill('allin'));
  });

  it('reads a short button jam as much wider than the same jam from early position', () => {
    // Big blind with A9o facing a 10bb open-jam: the button jams ~half its
    // hands and gets called; the same wager from early position is respected.
    const facing = (aggressorPosition: 'btn' | 'early') =>
      decide({
        personality: expert,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('Ah 9d') as [Card, Card],
          position: 'bb',
          positionFactor: 0.2,
          tableSize: 6,
          liveOpponents: 1,
          potBefore: 23,
          toCall: 18,
          stack: 18,
          effectiveStack: 18,
          streetCommitted: 2,
          totalCommitted: 2,
          currentBet: 20,
          maxRaiseTo: 20,
          canRaise: false,
          preflopPotType: 'singleRaised',
          preflopRaiseCount: 1,
          aggressorPosition,
          committedOpponents: 1,
          playersBehind: 0,
        }),
        rng: seeded(13_000),
        iterations: 600,
      });
    expect(facing('btn').action).toBe('call');
    expect(facing('btn').reason).toContain('villR=0.30');
    expect(facing('early').reason).toContain('villR=0.24');
  });

  it('does not call a 100bb open shove with dominated broadways', () => {
    for (const hand of ['As Td', 'Ks Jd', 'Ks Qd']) {
      for (let s = 0; s < 12; s++) {
        const d = decide({
          personality: expert,
          difficulty: 'hard',
          ctx: ctx({
            hole: parseCards(hand) as [Card, Card],
            potBefore: 203,
            toCall: 200,
            stack: 200,
            effectiveStack: 200,
            currentBet: 200,
            maxRaiseTo: 200,
            canRaise: false,
            preflopPotType: 'singleRaised',
            preflopRaiseCount: 1,
          }),
          rng: seeded(11_000 + s),
          iterations: 500,
        });
        expect(d.action).toBe('fold');
      }
    }
  });

  it('isolates a short all-in with aces while active players remain', () => {
    const d = decide({
      personality: expert,
      difficulty: 'hard',
      ctx: ctx({
        hole: parseCards('As Ad') as [Card, Card],
        liveOpponents: 3,
        potBefore: 17,
        toCall: 10,
        currentBet: 10,
        effectiveStack: 10,
        canRaise: true,
        minRaiseTo: 18,
        maxRaiseTo: 200,
        preflopPotType: 'singleRaised',
        preflopRaiseCount: 1,
      }),
      rng: seeded(11_500),
    });
    expect(d.action).toBe('raise');
    expect(d.reason).toContain('pf-jam-isolate');
  });

  it('shoves aces instead of flatting a committing 3-bet at 15bb', () => {
    const d = decide({
      personality: expert,
      difficulty: 'hard',
      ctx: ctx({
        hole: parseCards('As Ad') as [Card, Card],
        potBefore: 29,
        toCall: 14,
        currentBet: 20,
        streetCommitted: 6,
        totalCommitted: 6,
        stack: 24,
        effectiveStack: 24,
        canRaise: true,
        minRaiseTo: 30,
        maxRaiseTo: 30,
        preflopPotType: 'threeBet',
        preflopRaiseCount: 2,
      }),
      rng: seeded(11_501),
    });
    expect(d.action).toBe('allin');
    expect(d.reason).toContain('pf-jam-isolate');
  });

  it('does not turn KQs into a 200bb isolation bluff over a 100bb jam', () => {
    for (let seed = 0; seed < 6; seed++) {
      const d = decide({
        personality: expert,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('Ks Qs') as [Card, Card],
          liveOpponents: 2,
          potBefore: 203,
          toCall: 199,
          currentBet: 200,
          streetCommitted: 1,
          totalCommitted: 1,
          stack: 399,
          effectiveStack: 199,
          canRaise: true,
          minRaiseTo: 398,
          maxRaiseTo: 400,
          preflopPotType: 'singleRaised',
          preflopRaiseCount: 1,
        }),
        rng: seeded(11_600 + seed),
      });
      expect(d.action).toBe('fold');
      expect(d.reason).toContain('pf-jam-fold');
    }
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

describe('cash-game raise sizing (no 50-100bb spikes)', () => {
  const aa = parseCards('As Ad') as [Card, Card];

  it('preflop open stays around 2-4 big blinds', () => {
    for (let s = 0; s < 25; s++) {
      const d = decide({
        personality: { ...tag, pfr: 0.9 },
        difficulty: 'medium',
        ctx: ctx({ hole: aa, toCall: 2, potBefore: 3, streetCommitted: 0, minRaiseTo: 4, maxRaiseTo: 400, stack: 400 }),
        rng: seeded(s + 1000),
      });
      if (d.action === 'raise') {
        expect(d.amount).toBeLessThanOrEqual(8); // ≤ 4 BB open
        expect(d.amount).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('preflop 3-bet is a normal multiple of the open, not pot-spiral', () => {
    // Facing a 3bb open (6 chips): 3-bet should land ~2.2-3.2x = 13-20 chips.
    for (let s = 0; s < 25; s++) {
      const d = decide({
        personality: { ...tag, pfr: 0.9 },
        difficulty: 'medium',
        ctx: ctx({ hole: aa, toCall: 6, potBefore: 9, streetCommitted: 0, minRaiseTo: 10, maxRaiseTo: 400, stack: 400 }),
        rng: seeded(s + 1100),
      });
      if (d.action === 'raise') {
        expect(d.amount).toBeLessThanOrEqual(22); // ≤ ~11 BB, no 50bb jumps
      }
    }
  });

  it('river raise stays near 2-3x the bet faced', () => {
    const board = parseCards('Ah Kd 7s 4c 2d');
    for (let s = 0; s < 25; s++) {
      const d = decide({
        personality: { ...tag, aggression: 0.9 },
        difficulty: 'medium',
        ctx: ctx({
          hole: aa,
          board,
          street: 'river',
          canCheck: false,
          toCall: 20,
          potBefore: 60,
          streetCommitted: 0,
          minRaiseTo: 40,
          maxRaiseTo: 400,
          stack: 400,
        }),
        rng: seeded(s + 1200),
        iterations: 150,
      });
      if (d.action === 'raise') {
        expect(d.amount).toBeLessThanOrEqual(80); // OOP may use ~3.3x, never a stack-sized spike
      }
    }
  });
});

describe('stake budgeting (single-hand investment discipline)', () => {
  it('never re-raises a weak hand in an escalated pot (call or fold only)', () => {
    // Raise war already at 30bb; a weak hand must not keep escalating.
    const hole = parseCards('7s 2d') as [Card, Card];
    const board = parseCards('Kh 9c 4d');
    for (let s = 0; s < 30; s++) {
      const d = decide({
        personality: { ...tag, aggression: 0.9, bluff: 0.4 },
        difficulty: 'medium',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 60,
          potBefore: 150,
          streetCommitted: 0,
          totalCommitted: 40,
          minRaiseTo: 120,
          maxRaiseTo: 340,
          stack: 340,
        }),
        rng: seeded(s + 1300),
        iterations: 120,
      });
      expect(['fold', 'call']).toContain(d.action);
    }
  });

  it('stops raising a decent-but-not-monster hand once ~50bb is invested', () => {
    // Mid pair, already 100 chips (50bb) in: no further escalation.
    const hole = parseCards('8h 8c') as [Card, Card];
    const board = parseCards('Ad 7s 2c');
    for (let s = 0; s < 30; s++) {
      const d = decide({
        personality: { ...tag, aggression: 0.9 },
        difficulty: 'medium',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 30,
          potBefore: 220,
          streetCommitted: 0,
          totalCommitted: 100,
          minRaiseTo: 60,
          maxRaiseTo: 300,
          stack: 300,
        }),
        rng: seeded(s + 1400),
        iterations: 120,
      });
      expect(d.action).not.toBe('raise');
      expect(d.action).not.toBe('allin');
    }
  });

  it('still allows stacking off with a near-nut hand', () => {
    // Top set on a dry board: budget is uncapped, raises stay possible.
    const hole = parseCards('Kh Kc') as [Card, Card];
    const board = parseCards('Ks 7d 2c');
    let raises = 0;
    for (let s = 0; s < 30; s++) {
      const d = decide({
        personality: { ...tag, aggression: 0.9 },
        difficulty: 'medium',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 30,
          potBefore: 100,
          streetCommitted: 0,
          totalCommitted: 60,
          minRaiseTo: 60,
          maxRaiseTo: 300,
          stack: 300,
        }),
        rng: seeded(s + 1500),
        iterations: 150,
      });
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    expect(raises).toBeGreaterThan(0);
  });
});

describe('hand story-line: barrel planning', () => {
  const air = parseCards('7s 2d') as [Card, Card];
  const board = parseCards('Kh 9c 4d 6s'); // turn, we c-bet flop as a bluff

  function betRate(withStory: boolean): number {
    let bets = 0;
    const n = 40;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: { ...tag, bluff: 0.15 },
        difficulty: 'hard',
        ctx: ctx({
          hole: air,
          board,
          street: 'turn',
          canCheck: true,
          toCall: 0,
          potBefore: 24,
          wasAggressorLastStreet: withStory,
          myBluffsThisHand: withStory ? 1 : 0,
          bluffedLastStreet: withStory,
        }),
        rng: seeded(s + 2000),
        iterations: 120,
      });
      if (d.action === 'raise' || d.action === 'allin') bets++;
    }
    return bets / n;
  }

  it('continues a flop bluff on the turn far more often than an independent re-roll', () => {
    const barrel = betRate(true);
    const independent = betRate(false);
    expect(barrel).toBeGreaterThan(independent + 0.15);
    expect(barrel).toBeGreaterThan(0.4); // a real double-barrel plan
  });
});

describe('action-line awareness: check-raise respect', () => {
  const hand = parseCards('Ah 9d') as [Card, Card]; // top pair weak kicker
  const board = parseCards('As 8c 3d');

  function meanPerceivedEquity(checkRaised: boolean): number {
    let sum = 0;
    const n = 25;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: hand,
          board,
          street: 'flop',
          canCheck: false,
          toCall: 24,
          potBefore: 36,
          facingCheckRaise: checkRaised,
        }),
        rng: seeded(s + 2100),
        iterations: 200,
      });
      // The decision trace starts with "eq=0.xx".
      const m = /eq=([\d.]+)/.exec(d.reason);
      sum += m ? Number(m[1]) : 0;
    }
    return sum / n;
  }

  it('rates the same hand lower against a check-raise (stronger range assumed)', () => {
    const vsBet = meanPerceivedEquity(false);
    const vsCheckRaise = meanPerceivedEquity(true);
    expect(vsCheckRaise).toBeLessThan(vsBet - 0.04);
  });
});

describe('blocker-aware 4-bet mixing', () => {
  it('jams a premium over a 3-bet at 40bb but keeps a normal size at 300bb', () => {
    const spot = {
      hole: parseCards('As Ad') as [Card, Card],
      potBefore: 29,
      toCall: 14,
      currentBet: 20,
      streetCommitted: 6,
      totalCommitted: 6,
      minRaiseTo: 34,
      preflopPotType: 'threeBet' as const,
      preflopRaiseCount: 2,
    };
    const shallow = decide({
      personality: tag,
      difficulty: 'hard',
      ctx: ctx({
        ...spot,
        stack: 74,
        effectiveStack: 74,
        maxRaiseTo: 80,
      }),
      rng: seeded(2120),
    });
    const deep = decide({
      personality: tag,
      difficulty: 'hard',
      ctx: ctx({
        ...spot,
        stack: 594,
        effectiveStack: 594,
        maxRaiseTo: 600,
      }),
      rng: seeded(2120),
    });
    expect(shallow.action).toBe('allin');
    expect(deep.action).toBe('raise');
    expect(deep.amount).toBeLessThan(100);
  });

  it('still value 4-bets a normal 18bb 3-bet when stacks are deep', () => {
    for (let s = 0; s < 12; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('As Ad') as [Card, Card],
          potBefore: 45,
          toCall: 30,
          currentBet: 36,
          streetCommitted: 6,
          totalCommitted: 6,
          minRaiseTo: 66,
          maxRaiseTo: 400,
          stack: 394,
          preflopPotType: 'threeBet',
          preflopRaiseCount: 2,
        }),
        rng: seeded(s + 2150),
      });
      expect(d.action).toBe('raise');
      expect(d.reason).toContain('pf-value-4bet');
    }
  });

  it('occasionally 4-bets a suited wheel ace (rare, not never)', () => {
    const hole = parseCards('As 5s') as [Card, Card];
    let raises = 0;
    const n = 150;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          toCall: 20,
          potBefore: 30,
          streetCommitted: 0,
          totalCommitted: 0,
          minRaiseTo: 34,
          maxRaiseTo: 400,
          stack: 400,
          preflopPotType: 'threeBet',
          preflopRaiseCount: 2,
        }),
        rng: seeded(s + 2200),
      });
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    expect(raises).toBeGreaterThan(0); // the tell is broken…
    expect(raises / n).toBeLessThan(0.3); // …but it stays a bluff frequency
  });
});

describe('aggressive action EV', () => {
  it('uses both matched bets when a bet is called', () => {
    expect(actionEV(0.25, 100, 50, 0)).toBeCloseTo(0);
  });

  it('does not pretend the call portion of a raise is matched again', () => {
    const calledEV = actionEV(0.4, 100, 90, 0, 50);
    expect(calledEV).toBeCloseTo(6);
    expect(actionEV(0.4, 100, 90, 0.5, 50)).toBeCloseTo(53);
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

describe('hard exploits the observed human style', () => {
  // K7o sits just below a default button open; a steal read should add it.
  const marginalHole = parseCards('Kc 7d') as [Card, Card];

  function stealRaiseRate(withProfile: boolean): number {
    const profile = {
      ...emptyHeroProfile(),
      hands: 60,
      foldToSteal: 0.9,
      counters: {
        ...emptyHeroProfile().counters,
        handsDealt: 60,
        stealFaced: 10,
        stealFacedFolds: 9,
      },
    };
    let raises = 0;
    const n = 40;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: marginalHole,
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

  // 150 chances to open the betting, 90% of them taken with the given size.
  const bettor = (size: 'smallBets' | 'mediumBets' | 'bigBets') => ({
    ...emptyHeroProfile(),
    hands: 120,
    counters: {
      ...emptyHeroProfile().counters,
      handsDealt: 120,
      betOpportunities: 150,
      [size]: 135,
    },
  });

  // 40 of the player's bets or raises were raised, and it folded `folded` of them.
  const raisedBettor = (folded: number): HeroProfile => ({
    ...emptyHeroProfile(),
    hands: 120,
    counters: {
      ...emptyHeroProfile().counters,
      handsDealt: 120,
      raisesFaced: 40,
      raisesFolded: folded,
    },
  });

  function responses(
    hole: string,
    board: Card[],
    betToPot: number,
    profile?: HeroProfile,
  ): { fold: number; raise: number } {
    let folds = 0;
    let raises = 0;
    const n = 50;
    const pot = 40;
    const bet = Math.round(pot * betToPot);
    const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards(hole) as [Card, Card],
          board,
          street,
          potBefore: pot + bet,
          toCall: bet,
          currentBet: bet,
          minRaiseTo: bet * 2,
          betToPot,
          streetAggressionCount: 1,
          aggressorIsHero: true,
          checkedThisStreet: true,
          preflopRaised: true,
        }),
        rng: seeded(s + 950),
        iterations: 200,
        heroProfile: profile,
      });
      if (d.action === 'fold') folds++;
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    return { fold: folds / n, raise: raises / n };
  }
  const foldRate = (...args: Parameters<typeof responses>) => responses(...args).fold;

  it('widens the range of a player who stabs small at every chance', () => {
    const flop = parseCards('Ks 7c 2d');
    const standard = foldRate('Qh Jd', flop, 0.3);
    const stabber = foldRate('Qh Jd', flop, 0.3, bettor('smallBets'));
    expect(stabber).toBeLessThan(standard - 0.2);
  });

  it('calls down a frequent overbettor lighter', () => {
    const turn = parseCards('Ks 7c 2d 4h');
    const standard = foldRate('6h 6d', turn, 1.2);
    const overbettor = foldRate('6h 6d', turn, 1.2, bettor('bigBets'));
    expect(overbettor).toBeLessThan(standard - 0.3);
    // The read is per size: a small-bet habit says nothing about overbets.
    expect(foldRate('6h 6d', turn, 1.2, bettor('smallBets'))).toBeGreaterThan(overbettor + 0.3);
  });

  // A flop c-bettor who bets half pot at 70% of its flop chances and switches
  // to overbets on the turn and river; `split: false` is the same history seen
  // only through the pooled counters (as a profile saved before the split).
  const streetBettor = (split: boolean): HeroProfile => {
    const counters = {
      ...emptyHeroProfile().counters,
      handsDealt: 120,
      betOpportunities: 150,
      mediumBets: 49,
      bigBets: 55,
      continuationChances: 90,
      continuationBets: 70,
    };
    if (split) {
      Object.assign(counters, {
        flopBetChances: 70,
        flopMediumBets: 49,
        turnBetChances: 45,
        turnBigBets: 30,
        riverBetChances: 35,
        riverBigBets: 25,
      });
    }
    return { ...emptyHeroProfile(), hands: 120, counters };
  };
  const readOn = (street: 'flop' | 'turn' | 'river', profile: HeroProfile) =>
    computeExploit('hard', ctx({ hole: parseCards('Qh Jd') as [Card, Card], street }), profile);

  it('reads opening-bet width per street, so later overbets do not dilute the flop c-bet read', () => {
    const pooled = readOn('flop', streetBettor(false)).betWidth.medium;
    const flop = readOn('flop', streetBettor(true)).betWidth.medium;
    expect(flop).toBeGreaterThan(1.5);
    expect(flop).toBeGreaterThan(pooled + 0.3);
    const turn = readOn('turn', streetBettor(true)).betWidth;
    expect(turn.big).toBeGreaterThan(1.8);
    // It never bets half pot on the turn, so such a bet is no wide stab.
    expect(turn.medium).toBeLessThan(1);
  });

  it('defends wider against the flop c-bets of that per-street profile', () => {
    const flop = parseCards('Ks 8c 3d');
    const hands = ['Qh Jd', 'Ah 5d', 'Th 9h', '7h 7d', 'Jc Tc'];
    const total = (profile: HeroProfile) =>
      hands.reduce((sum, h) => sum + foldRate(h, flop, 0.5, profile), 0) / hands.length;
    expect(total(streetBettor(true))).toBeLessThan(total(streetBettor(false)) - 0.05);
  });

  it('does not read a rare standard-size river bettor as wide', () => {
    // Bets 20% of river chances, all half pot: fewer bets than the population,
    // at a size the population seldom uses on the river.
    const valueBettor: HeroProfile = {
      ...emptyHeroProfile(),
      hands: 150,
      counters: {
        ...emptyHeroProfile().counters,
        handsDealt: 150,
        betOpportunities: 120,
        mediumBets: 24,
        riverBetChances: 120,
        riverMediumBets: 24,
      },
    };
    expect(readOn('river', valueBettor).betWidth.medium).toBeLessThan(1);
  });

  it('reads flop c-bets and turn barrels as separate habits', () => {
    const cbetNoBarrel: HeroProfile = {
      ...emptyHeroProfile(),
      hands: 120,
      counters: {
        ...emptyHeroProfile().counters,
        handsDealt: 120,
        continuationChances: 80,
        continuationBets: 50,
        flopContinuationChances: 50,
        flopContinuationBets: 45,
        turnContinuationChances: 30,
        turnContinuationBets: 5,
      },
    };
    expect(readOn('flop', cbetNoBarrel).leadMult).toBeLessThan(0.7);
    expect(readOn('turn', cbetNoBarrel).leadMult).toBeGreaterThan(1.8);
  });

  it('keeps checking to a raiser who barrels less often but overbets the barrels it makes', () => {
    // Barrels 25 of 45 turns (the norm is 70%): with half-pot barrels it gives
    // free cards, with overbets it fires its air at anyone who checks.
    const barrels = (size: 'turnMediumBets' | 'turnBigBets'): HeroProfile => {
      const profile = streetBettor(true);
      Object.assign(profile.counters, {
        turnContinuationChances: 45,
        turnContinuationBets: 25,
        turnMediumBets: 0,
        turnBigBets: 0,
        [size]: 25,
      });
      return profile;
    };
    expect(readOn('turn', barrels('turnMediumBets')).leadMult).toBeGreaterThan(1.05);
    expect(readOn('turn', barrels('turnBigBets')).leadMult).toBeLessThan(0.8);
  });

  it('raises the stabs of a player who folds to raises with any hand', () => {
    const flop = parseCards('Ks 7c 2d');
    const standard = responses('Qh Jd', flop, 0.3).raise;
    const folder = responses('Qh Jd', flop, 0.3, raisedBettor(32)).raise;
    expect(folder).toBeGreaterThan(standard + 0.2);
  });

  it('semi-bluff raises a player who never folds to a raise less', () => {
    const flop = parseCards('9h 8c 2h');
    const standard = responses('Jh Th', flop, 0.5).raise;
    const sticky = responses('Jh Th', flop, 0.5, raisedBettor(2)).raise;
    expect(sticky).toBeLessThan(standard - 0.1);
    // Folding to raises at the usual rate adds no light raises.
    expect(responses('Qh Jd', parseCards('Ks 7c 2d'), 0.3, raisedBettor(16)).raise).toBeLessThan(0.2);
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

describe('multiway post-flop initiative (hard)', () => {
  const air = parseCards('7s 2d') as [Card, Card];
  const dryFlop = parseCards('Kh 8c 3d');

  function betRate(partial: Partial<DecisionContext>, seedBase: number): number {
    let bets = 0;
    const n = 80;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: air,
          board: dryFlop,
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 24,
          liveOpponents: 2,
          positionFactor: 0.7,
          preflopPotType: 'singleRaised',
          ...partial,
        }),
        rng: seeded(seedBase + s),
        iterations: 120,
      });
      if (d.action === 'raise' || d.action === 'allin') bets++;
    }
    return bets / n;
  }

  it('uses a controlled multiway c-bet range when it has pre-flop initiative', () => {
    const withInitiative = betRate({ wasAggressorLastStreet: true }, 7200);
    const withoutInitiative = betRate({ wasAggressorLastStreet: false }, 7200);
    expect(withInitiative).toBeGreaterThan(withoutInitiative + 0.1);
    expect(withInitiative).toBeLessThan(0.6);
  });

  it('keeps pair-plus-draw range c-bets connected to the semi-bluff barrel plan', () => {
    const hole = parseCards('7h 3h') as [Card, Card];
    const board = parseCards('9h 7c 2h');
    let rangeCbets = 0;
    for (let s = 0; s < 100; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 24,
          liveOpponents: 2,
          positionFactor: 0.7,
          preflopPotType: 'singleRaised',
          wasAggressorLastStreet: true,
        }),
        rng: seeded(7250 + s),
        iterations: 120,
      });
      if (d.reason.endsWith('range-cbet')) {
        rangeCbets++;
        expect(d.isBluff).toBe(true);
      }
    }
    expect(rangeCbets).toBeGreaterThan(5);
  });

  it('probes more often after a full street checks through', () => {
    const board = parseCards('Kh 8c 3d 6s');
    const rate = (checkedThrough: boolean): number => {
      let bets = 0;
      const n = 80;
      for (let s = 0; s < n; s++) {
        const d = decide({
          personality: tag,
          difficulty: 'hard',
          ctx: ctx({
            hole: air,
            board,
            street: 'turn',
            canCheck: true,
            toCall: 0,
            potBefore: 24,
            liveOpponents: 2,
            positionFactor: 0.8,
            previousStreetCheckedThrough: checkedThrough,
            preflopPotType: 'singleRaised',
          }),
          rng: seeded(7300 + s),
          iterations: 120,
        });
        if (d.action === 'raise' || d.action === 'allin') bets++;
      }
      return bets / n;
    };

    const probe = rate(true);
    const noStory = rate(false);
    expect(probe).toBeGreaterThan(noStory + 0.12);
    expect(probe).toBeLessThan(0.65);
  });

  it('mixes top-pair protection bets instead of always checking below the equity threshold', () => {
    const hole = parseCards('Ah 9d') as [Card, Card];
    const board = parseCards('As 8c 3d');
    let protectionBets = 0;
    const n = 80;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board,
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 24,
          liveOpponents: 2,
          positionFactor: 0.7,
          preflopPotType: 'singleRaised',
          // The pre-flop raiser is checked to by two callers: their checks are
          // uninformative, so the weak-kicker top pair stays below the value
          // threshold and must be mixed as a protection bet.
          wasAggressorLastStreet: true,
        }),
        rng: seeded(7400 + s),
        iterations: 140,
      });
      if (d.reason.endsWith('protection-value')) protectionBets++;
    }
    expect(protectionBets).toBeGreaterThan(10);
    expect(protectionBets).toBeLessThan(70);
  });
});

describe('cash-game defence vs an early-position open (hard)', () => {
  // Random hands, random hard personalities: measure how often each seat
  // continues (call or 3-bet) against a 3bb open in a 6-max game.
  function continueRate(positionFactor: number, streetCommitted: number, toCall: number, seed: number): number {
    const rng = seeded(seed);
    let cont = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const deck = shuffle(makeDeck(), rng);
      const d = decide({
        personality: generatePersonality('hard', rng),
        difficulty: 'hard',
        ctx: ctx({
          hole: [deck[0], deck[1]],
          potBefore: 9,
          toCall,
          streetCommitted,
          totalCommitted: streetCommitted,
          positionFactor,
          minRaiseTo: 12,
          recentImage: 0.3,
        }),
        rng,
      });
      if (d.action !== 'fold') cont++;
    }
    return cont / n;
  }

  it('late position (CO/BTN) defends far more than middle position', () => {
    const btn = continueRate(1, 0, 6, 11);
    const co = continueRate(0.8, 0, 6, 12);
    const mp = continueRate(0.4, 0, 6, 13);
    expect(btn).toBeGreaterThan(0.2);
    expect(co).toBeGreaterThan(0.18);
    expect(btn).toBeGreaterThan(mp + 0.04);
  });

  it('the big blind defends by price (well over a third of hands)', () => {
    const bb = continueRate(0.2, 2, 4, 14);
    const sb = continueRate(0, 1, 5, 15);
    expect(bb).toBeGreaterThan(0.35);
    expect(bb).toBeGreaterThan(sb);
  });

  it('tightens smoothly rather than falling off a hard open-size cliff', () => {
    function bbRate(openBB: number): number {
      const rng = seeded(7777);
      let continues = 0;
      const n = 350;
      for (let i = 0; i < n; i++) {
        const deck = shuffle(makeDeck(), rng);
        const level = openBB * 2;
        const d = decide({
          personality: generatePersonality('hard', rng),
          difficulty: 'hard',
          ctx: ctx({
            hole: [deck[0], deck[1]],
            potBefore: level + 3,
            toCall: level - 2,
            currentBet: level,
            streetCommitted: 2,
            totalCommitted: 2,
            position: 'bb',
            positionFactor: 0.2,
            preflopPotType: 'singleRaised',
            preflopRaiseCount: 1,
            minRaiseTo: level * 2 - 2,
          }),
          rng,
        });
        if (d.action !== 'fold') continues++;
      }
      return continues / n;
    }

    const fourAndHalf = bbRate(4.5);
    const five = bbRate(5);
    expect(fourAndHalf).toBeGreaterThan(five);
    expect(fourAndHalf - five).toBeLessThan(0.12);
  });

  it('reads the opener by table seat, not by who happens to act last heads-up', () => {
    // Once the table folds, an under-the-gun opener acts last against the big
    // blind exactly like the button. K9o defends the button steal only.
    const defend = (aggressorPosition: 'btn' | 'early') =>
      decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('Kh 9d') as [Card, Card],
          potBefore: 9,
          toCall: 4,
          currentBet: 6,
          streetCommitted: 2,
          totalCommitted: 2,
          position: 'bb',
          positionFactor: 0,
          tableSize: 6,
          preflopPotType: 'singleRaised',
          preflopRaiseCount: 1,
          aggressorPosition,
          aggressorPositionFactor: 1,
          inPositionVsAggressor: false,
          minRaiseTo: 10,
        }),
        rng: seeded(21),
      }).action;
    expect(defend('btn')).not.toBe('fold');
    expect(defend('early')).toBe('fold');
  });

  it('carries the raiser seat and the caller role into the post-flop range', () => {
    const flopReason = (partial: Partial<DecisionContext>) =>
      decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: parseCards('Kh 9d') as [Card, Card],
          board: parseCards('9s 5c 2d'),
          street: 'flop',
          potBefore: 13,
          toCall: 4,
          currentBet: 4,
          tableSize: 6,
          preflopPotType: 'singleRaised',
          preflopRaiseCount: 1,
          ...partial,
        }),
        rng: seeded(5),
        iterations: 200,
      }).reason;
    const raiser = (position: 'early' | 'btn') => ({
      preflopAggressorPosition: position,
      rangeOpponentPosition: position,
      rangeOpponentRaisedPreflop: true,
    });
    expect(flopReason(raiser('early'))).toContain('pfR=0.19');
    expect(flopReason(raiser('btn'))).toContain('pfR=0.48');
    // A big-blind caller leading into an early opener still holds a defend range.
    expect(
      flopReason({
        preflopAggressorPosition: 'early',
        rangeOpponentPosition: 'bb',
        rangeOpponentRaisedPreflop: false,
      }),
    ).toContain('pfR=0.36');
  });

  it('squeezes bigger with a premium when there are callers behind the raise', () => {
    const aces = parseCards('As Ad') as [Card, Card];
    let hu = 0;
    let sq = 0;
    let nHu = 0;
    let nSq = 0;
    for (let s = 0; s < 30; s++) {
      const base = { hole: aces, toCall: 6, minRaiseTo: 12, positionFactor: 1, maxRaiseTo: 400, stack: 400 };
      const a = decide({ personality: tag, difficulty: 'hard', ctx: ctx({ ...base, potBefore: 9 }), rng: seeded(s + 1) });
      const b = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({ ...base, potBefore: 21, callersAfterRaise: 2, preflopPotType: 'singleRaised', preflopRaiseCount: 1 }),
        rng: seeded(s + 1),
      });
      if (a.action === 'raise') { hu += a.amount; nHu++; }
      if (b.action === 'raise') { sq += b.amount; nSq++; }
    }
    expect(nSq).toBeGreaterThan(0);
    expect(sq / nSq).toBeGreaterThan(hu / nHu);
  });
});

describe('positional & stack-depth play (hard)', () => {
  const air = parseCards('7s 2d') as [Card, Card];
  const floatCandidate = parseCards('7s 5s') as [Card, Card];
  const board = parseCards('Kh 8c 3d');
  const floatBoard = parseCards('Kh 8c 3d 6s'); // turn, checked to a real draw

  function stabRate(inPosition: boolean, villainDroveLastStreet: boolean): number {
    let bets = 0;
    const n = 60;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole: floatCandidate,
          board: floatBoard,
          street: 'turn',
          canCheck: true,
          toCall: 0,
          potBefore: 20,
          positionFactor: inPosition ? 1 : 0,
          villainWasAggressorLastStreet: villainDroveLastStreet,
          villainCheckedToMe: villainDroveLastStreet,
          wasAggressorLastStreet: false,
          inPositionVsAggressor: inPosition,
          preflopRaised: true,
        }),
        rng: seeded(s + 3000),
        iterations: 100,
      });
      if (d.action === 'raise') bets++;
    }
    return bets / n;
  }

  it('floats: stabs much more when the previous-street aggressor checks to it in position', () => {
    const floatIp = stabRate(true, true);
    const noStory = stabRate(true, false);
    // Both checks cap the villain's range (the checker model), so the float
    // story adds a moderate premium on top of the ordinary semi-bluff.
    expect(floatIp).toBeGreaterThan(noStory + 0.1);
    expect(floatIp).toBeGreaterThan(stabRate(false, true));
  });

  it('calls with a flush draw more often deep-stacked than shallow (implied odds)', () => {
    const hole = parseCards('9h 8h') as [Card, Card];
    const drawBoard = parseCards('Ah 5h 2c');
    function callRate(stack: number): number {
      let calls = 0;
      const n = 40;
      for (let s = 0; s < n; s++) {
        const d = decide({
          personality: tag,
          difficulty: 'hard',
          ctx: ctx({
            hole,
            board: drawBoard,
            street: 'flop',
            potBefore: 40,
            toCall: 30,
            stack,
            maxRaiseTo: stack,
            minRaiseTo: 60,
            positionFactor: 1,
            preflopRaised: true,
          }),
          rng: seeded(s + 4000),
          iterations: 150,
        });
        if (d.action !== 'fold') calls++;
      }
      return calls / n;
    }
    expect(callRate(400)).toBeGreaterThanOrEqual(callRate(45));
  });

  it('a tight image makes bluffing more credible than an aggressive image', () => {
    const base = ctx({ hole: air, board, street: 'flop', canCheck: true, toCall: 0, potBefore: 12, positionFactor: 0.8 });
    const tight = dynamicBluffFrequency(tag, { ...base, recentImage: 0.05 });
    const wild = dynamicBluffFrequency(tag, { ...base, recentImage: 0.7 });
    expect(tight).toBeGreaterThan(wild);
  });

  it('polarises river sizing: nut value and bluffs bet big, thin value bets small', () => {
    const riverBoard = parseCards('Kh 8c 3d 2s 9c');
    const sizes = (hole: [Card, Card]) => {
      const out: number[] = [];
      for (let s = 0; s < 40; s++) {
        const d = decide({
          personality: tag,
          difficulty: 'hard',
          ctx: ctx({ hole, board: riverBoard, street: 'river', canCheck: true, toCall: 0, potBefore: 40, minRaiseTo: 2 }),
          rng: seeded(s + 5000),
          iterations: 150,
        });
        if (d.action === 'raise') out.push(d.amount / 40);
      }
      return out;
    };
    const nuts = sizes(parseCards('Ks Kd') as [Card, Card]);
    const thin = sizes(parseCards('Kd 5d') as [Card, Card]);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    expect(nuts.length).toBeGreaterThan(0);
    expect(thin.length).toBeGreaterThan(0);
    expect(avg(nuts)).toBeGreaterThan(avg(thin) + 0.15);
  });
});

describe('check to the raiser, then check-raise (hard)', () => {
  const board = parseCards('Kh 8c 3d');
  const set = parseCards('8s 8d') as [Card, Card];

  function leadRate(aggressorCheckedFirst: boolean, heroProfile?: HeroProfile): number {
    let bets = 0;
    const n = 60;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        heroProfile,
        ctx: ctx({
          aggressorIsHero: !!heroProfile,
          hole: set,
          board,
          street: 'flop',
          canCheck: true,
          toCall: 0,
          potBefore: 13,
          minRaiseTo: 2,
          positionFactor: aggressorCheckedFirst ? 1 : 0,
          villainWasAggressorLastStreet: true,
          villainCheckedToMe: aggressorCheckedFirst,
          wasAggressorLastStreet: false,
          inPositionVsAggressor: aggressorCheckedFirst,
          preflopRaised: true,
          preflopPotType: 'singleRaised',
        }),
        rng: seeded(s + 6000),
        iterations: 150,
      });
      if (d.action === 'raise' || d.action === 'allin') bets++;
    }
    return bets / n;
  }

  it('checks a set to the raiser instead of leading into it', () => {
    const lead = leadRate(false);
    expect(lead).toBeLessThan(0.4);
    // Once the raiser has checked, the same set bets for value.
    expect(leadRate(true)).toBeGreaterThan(lead + 0.4);
  });

  it('leads more into a human raiser who seldom follows through', () => {
    const passiveRaiser: HeroProfile = {
      ...emptyHeroProfile(),
      hands: 120,
      counters: {
        ...emptyHeroProfile().counters,
        handsDealt: 120,
        continuationChances: 60,
        continuationBets: 12,
      },
    };
    expect(leadRate(false, passiveRaiser)).toBeGreaterThan(leadRate(false) + 0.15);
  });

  function raiseRate(hole: [Card, Card], flop: Card[], checkedFirst: boolean): number {
    let raises = 0;
    const n = 80;
    for (let s = 0; s < n; s++) {
      const d = decide({
        personality: tag,
        difficulty: 'hard',
        ctx: ctx({
          hole,
          board: flop,
          street: 'flop',
          potBefore: 19,
          toCall: 6,
          currentBet: 6,
          minRaiseTo: 12,
          positionFactor: checkedFirst ? 0 : 1,
          checkedThisStreet: checkedFirst,
          streetAggressionCount: 1,
          betToPot: 0.46,
          villainWasAggressorLastStreet: true,
          inPositionVsAggressor: !checkedFirst,
          preflopRaised: true,
          preflopPotType: 'singleRaised',
        }),
        rng: seeded(s + 7000),
        iterations: 150,
      });
      if (d.action === 'raise' || d.action === 'allin') raises++;
    }
    return raises / n;
  }

  it('check-raises a set and a strong draw against the c-bet', () => {
    expect(raiseRate(set, board, true)).toBeGreaterThan(0.5);
    const comboDraw = parseCards('Jh Th') as [Card, Card];
    const wetFlop = parseCards('9h 8c 2h');
    const xr = raiseRate(comboDraw, wetFlop, true);
    expect(xr).toBeGreaterThan(0.2);
    // Facing the same bet in position is a call-first spot for the draw.
    expect(xr).toBeGreaterThan(raiseRate(comboDraw, wetFlop, false));
  });
});

describe('all-in opponents and side pots (hard)', () => {
  // A 20bb shove before the flop was called by us and by a deep player who
  // acts after us: the whole 120-chip pot is a main pot the shover contests
  // without being able to fold, bet or be checked to.
  const flop = parseCards('Kd 8s 3c');
  const shover = { opponents: 1, idle: 1, idleShare: 1, bettor: false, callers: 0, pot: 120, aggressor: true };
  const spot = (hole: string, partial: Partial<DecisionContext> = {}): DecisionContext =>
    ctx({
      hole: parseCards(hole) as [Card, Card],
      board: flop,
      street: 'flop',
      canCheck: true,
      toCall: 0,
      liveOpponents: 2,
      potBefore: 120,
      stack: 160,
      maxRaiseTo: 160,
      minRaiseTo: 2,
      effectiveStack: 160,
      totalCommitted: 40,
      positionFactor: 0.3,
      playersBehind: 1,
      preflopRaised: true,
      preflopPotType: 'singleRaised',
      villainWasAggressorLastStreet: true,
      inPositionVsAggressor: false,
      winnablePot: 120,
      allIn: shover,
      ...partial,
    });
  // The deep player bets 60 into the main pot after we check.
  const facingSideBet = (hole: string, partial: Partial<DecisionContext> = {}) =>
    spot(hole, {
      canCheck: false,
      toCall: 60,
      currentBet: 60,
      potBefore: 180,
      minRaiseTo: 120,
      playersBehind: 0,
      checkedThisStreet: true,
      streetAggressionCount: 1,
      betToPot: 0.5,
      winnablePot: 240,
      allIn: { ...shover, aggressor: false },
      ...partial,
    });
  const rate = (
    make: () => DecisionContext,
    match: (d: AIDecision) => boolean,
    iterations: number,
    seed: number,
  ): number => {
    let hits = 0;
    const n = 60;
    for (let s = 0; s < n; s++) {
      const d = decide({ personality: tag, difficulty: 'hard', ctx: make(), rng: seeded(seed + s), iterations });
      if (match(d)) hits++;
    }
    return hits / n;
  };
  const bets = (d: AIDecision) => d.action === 'raise' || d.action === 'allin';
  const continues = (d: AIDecision) => d.action !== 'fold';

  it('bets top pair into the live player instead of checking to an all-in raiser', () => {
    const allInRaiser = rate(() => spot('Kh Jd'), bets, 150, 8000);
    const liveRaiser = rate(
      () => spot('Kh Jd', { allIn: undefined, winnablePot: undefined }),
      bets,
      150,
      8000,
    );
    expect(allInRaiser).toBeGreaterThan(0.8);
    expect(liveRaiser).toBeLessThan(allInRaiser - 0.5);
  });

  it('does not bluff when the pot is a main pot the all-in player cannot fold', () => {
    for (const air of ['7h 6h', 'Qh Jh']) {
      expect(rate(() => spot(air), bets, 150, 8100)).toBeLessThan(0.08);
    }
  });

  it('calls the live bettor wider with a hand that still beats the all-in range', () => {
    // Calling also keeps our share of the main pot, won against the shover's
    // wide range rather than the bettor's strong one.
    const layered = rate(() => facingSideBet('Ah 3d'), continues, 200, 2000);
    const pooled = rate(
      () => facingSideBet('Ah 3d', { allIn: undefined, winnablePot: undefined }),
      continues,
      200,
      2000,
    );
    expect(layered).toBeGreaterThan(0.25);
    expect(layered).toBeGreaterThan(pooled + 0.15);
  });

  it('calls all-in for less at the price of the chips it can win', () => {
    // 20 chips behind facing 100 into 60: calling risks 20 to win 100 (20%),
    // not 100 to win 260.
    const short = (hole: string) =>
      ctx({
        hole: parseCards(hole) as [Card, Card],
        board: flop,
        street: 'flop',
        toCall: 100,
        currentBet: 100,
        potBefore: 160,
        stack: 20,
        maxRaiseTo: 20,
        effectiveStack: 20,
        totalCommitted: 30,
        canRaise: false,
        streetAggressionCount: 1,
        preflopRaised: true,
        preflopPotType: 'singleRaised',
        winnablePot: 100,
      });
    expect(rate(() => short('5h 5d'), continues, 150, 8300)).toBeGreaterThan(0.7);
    expect(rate(() => short('Qh Jh'), continues, 150, 8300)).toBeLessThan(0.45);
  });

  // Pre-flop at a 6-max table, button on seat 5 (UTG is seat 2), 100bb unless given.
  const preflop = (stacks: Record<number, number>, ...actions: [ActionType, number?][]) => {
    const table: SeatInit[] = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      name: `P${i}`,
      isHero: false,
      stack: (stacks[i] ?? 100) * BB_CHIPS,
    }));
    const config = { seatCount: 6, blindLevel: 1, startingStackBB: 100, difficulty: 'hard' } as const;
    const game = actions.reduce(
      (g, [type, amount = 0]) => applyAction(g, { type, amount }),
      startHand(config, table, 5, 1, () => 0.42),
    );
    return buildDecisionContext(game, game.toAct);
  };
  const withHole = (c: DecisionContext, hole: string): DecisionContext => ({
    ...c,
    hole: parseCards(hole) as [Card, Card],
  });

  it('plays a short all-in raise as a jam even with deep players behind', () => {
    // UTG shoves 18bb and it folds to the button; both blinds have 100bb.
    const jam = preflop({ 2: 18 }, ['allin'], ['fold'], ['fold']);
    expect(jam.effectiveStack).toBe(100 * BB_CHIPS);
    // A raise cannot fold the shover: only hands that want to isolate raise.
    expect(rate(() => withHole(jam, 'Kc Qc'), bets, 850, 9400)).toBe(0);
    expect(rate(() => withHole(jam, 'As Ah'), (d) => d.reason.includes('pf-jam-isolate'), 850, 9400)).toBe(1);
  });

  it('calls a pre-flop all-in for less at the price of the chips it can win', () => {
    // UTG opens 3bb, two players call and the button shoves 100bb: the big
    // blind's last 5bb win a 21.5bb main pot (23%), not 99bb into 209.5bb (47%).
    const dead = preflop({ 1: 6 }, ['raise', 3 * BB_CHIPS], ['call'], ['call'], ['allin'], ['fold']);
    expect(dead.winnablePot).toBe(21.5 * BB_CHIPS);
    expect(rate(() => withHole(dead, 'Kc Qc'), continues, 850, 9400)).toBeGreaterThan(0.9);
    expect(rate(() => withHole(dead, '7d 2c'), continues, 850, 9400)).toBe(0);
  });
});

describe('river bluffs linked to the bet size (hard)', () => {
  // A missed J-high heads-up on the river, checked to us in position.
  const board = parseCards('Ks 8d 3c 2h 5s');
  const river = (
    line: 'aggressor' | 'afterCheck',
    partial: Partial<DecisionContext> = {},
  ): DecisionContext =>
    ctx({
      hole: parseCards('Jh Th') as [Card, Card],
      board,
      street: 'river',
      canCheck: true,
      toCall: 0,
      potBefore: 40,
      stack: 160,
      maxRaiseTo: 160,
      minRaiseTo: 2,
      effectiveStack: 160,
      totalCommitted: 20,
      positionFactor: 1,
      inPositionVsAggressor: true,
      checkedThisStreet: true,
      preflopRaised: true,
      preflopPotType: 'singleRaised',
      ...(line === 'aggressor'
        ? { wasAggressorLastStreet: true }
        : { previousStreetCheckedThrough: true }),
      ...partial,
    });
  const sample = (make: () => DecisionContext, seed: number, heroProfile?: HeroProfile) =>
    Array.from({ length: 80 }, (_, s) =>
      decide({ personality: tag, difficulty: 'hard', ctx: make(), rng: seeded(seed + s), iterations: 150, heroProfile }),
    );
  const betRate = (ds: AIDecision[]) =>
    ds.filter((d) => d.action === 'raise' || d.action === 'allin').length / ds.length;

  it('bets its air as the aggressor, and less after a checked-through turn', () => {
    const aggressor = betRate(sample(() => river('aggressor'), 9100));
    const afterCheck = betRate(sample(() => river('afterCheck'), 9100));
    expect(aggressor).toBeGreaterThan(0.7);
    expect(afterCheck).toBeGreaterThan(0.2);
    expect(afterCheck).toBeLessThan(aggressor - 0.2);
  });

  it('splits the bluffs between the thin and the polar size', () => {
    const bluffs = sample(() => river('aggressor'), 9100).filter((d) => d.action === 'raise');
    const thin = bluffs.filter((d) => d.reason.endsWith('river-thin-bluff'));
    const polar = bluffs.filter((d) => d.reason.endsWith('river-polar-bluff'));
    expect(thin.length).toBeGreaterThan(bluffs.length * 0.3);
    expect(polar.length).toBeGreaterThan(bluffs.length * 0.15);
    expect(Math.max(...thin.map((d) => d.amount))).toBeLessThan(Math.min(...polar.map((d) => d.amount)));
  });

  it('bluffs a player who folds to river bets more, and a river station not at all', () => {
    const read = (faced: number, folds: number): HeroProfile => {
      const base = emptyHeroProfile();
      return {
        ...base,
        hands: 120,
        foldToRiverBet: (folds + RIVER_FOLD_PRIOR * 8) / (faced + 8),
        counters: { ...base.counters, handsDealt: 120, riverBetsFaced: faced, riverBetFolds: folds },
      };
    };
    const folder = read(30, 24);
    const station = read(30, 2);
    const spot = () => river('afterCheck', { aggressorIsHero: true });
    expect(computeExploit('hard', spot(), folder).riverFold).toBeGreaterThan(1.4);
    expect(computeExploit('hard', spot(), station).riverFold).toBeLessThan(0.6);
    const unread = betRate(sample(spot, 9300));
    expect(betRate(sample(spot, 9300, folder))).toBeGreaterThan(unread + 0.1);
    expect(betRate(sample(spot, 9300, station))).toBeLessThan(0.05);
  });
});
