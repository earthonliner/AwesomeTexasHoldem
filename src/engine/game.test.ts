import { describe, it, expect } from 'vitest';
import { startHand, applyAction, getLegalActions, totalPot, type SeatInit } from './game';
import type { GameConfig } from './gameTypes';
import { BB_CHIPS } from './gameTypes';

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

const config: GameConfig = { seatCount: 4, blindLevel: 1, startingStackBB: 100, difficulty: 'easy' };

function makeSeats(n: number, stack = 200): SeatInit[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: i === 0 ? 'Hero' : `AI${i}`,
    isHero: i === 0,
    stack,
  }));
}

describe('startHand', () => {
  it('posts small and big blinds', () => {
    const s = startHand(config, makeSeats(4), 0, 1, seeded(1));
    const committed = s.players.map((p) => p.streetCommitted);
    expect(committed).toContain(1); // SB
    expect(committed).toContain(2); // BB
    expect(s.currentBet).toBe(BB_CHIPS);
  });

  it('deals two hole cards to each seated player', () => {
    const s = startHand(config, makeSeats(6), 0, 1, seeded(2));
    for (const p of s.players) expect(p.hole).toHaveLength(2);
  });

  it('sets UTG to act first preflop in a full ring', () => {
    const s = startHand(config, makeSeats(4), 0, 1, seeded(3));
    // button=0, SB=1, BB=2, UTG=3
    expect(s.toAct).toBe(3);
  });

  it('heads-up: button posts SB and acts first preflop', () => {
    const s = startHand(config, makeSeats(2), 0, 1, seeded(4));
    expect(s.players[0].streetCommitted).toBe(1);
    expect(s.players[1].streetCommitted).toBe(2);
    expect(s.toAct).toBe(0);
  });
});

describe('legal actions', () => {
  it('UTG facing the big blind can fold/call/raise but not check', () => {
    const s = startHand(config, makeSeats(4), 0, 1, seeded(5));
    const la = getLegalActions(s, s.toAct);
    expect(la.canCheck).toBe(false);
    expect(la.canCall).toBe(true);
    expect(la.callAmount).toBe(2);
    expect(la.canRaise).toBe(true);
    expect(la.minRaiseTo).toBe(4); // BB + min raise (BB)
  });
});

describe('full hand flow', () => {
  it('awards the pot to the last player when everyone folds', () => {
    let s = startHand(config, makeSeats(4), 0, 1, seeded(6));
    // UTG folds, button folds, SB folds -> BB wins.
    s = applyAction(s, { type: 'fold', amount: 0 }); // UTG (3)
    s = applyAction(s, { type: 'fold', amount: 0 }); // button (0)
    s = applyAction(s, { type: 'fold', amount: 0 }); // SB (1)
    expect(s.status).toBe('complete');
    const bb = s.players[2];
    expect(s.payouts[0].playerId).toBe(bb.id);
    expect(s.payouts[0].amount).toBe(3); // SB + BB
  });

  it('conserves chips through an all-in showdown', () => {
    let s = startHand(config, makeSeats(3, 200), 0, 1, seeded(7));
    const startTotal = s.players.reduce((a, p) => a + p.stack, 0) + totalPot(s);

    // Drive everyone all-in.
    let guard = 0;
    while (s.status === 'betting' && guard++ < 50) {
      const idx = s.toAct;
      const la = getLegalActions(s, idx);
      s = applyAction(s, { type: 'allin', amount: la.maxRaiseTo });
    }
    expect(s.status).toBe('complete');
    expect(s.board).toHaveLength(5);
    const endTotal = s.players.reduce((a, p) => a + p.stack, 0);
    expect(endTotal).toBe(startTotal);
  });

  it('reaches showdown after a checked-down hand and conserves chips', () => {
    let s = startHand(config, makeSeats(4, 200), 0, 1, seeded(8));
    const startStacks = s.players.map((p) => p.stack + p.streetCommitted);

    let guard = 0;
    while (s.status === 'betting' && guard++ < 80) {
      const idx = s.toAct;
      const la = getLegalActions(s, idx);
      if (la.canCheck) {
        s = applyAction(s, { type: 'check', amount: 0 });
      } else if (la.callAmount <= 2) {
        s = applyAction(s, { type: 'call', amount: 0 });
      } else {
        s = applyAction(s, { type: 'fold', amount: 0 });
      }
    }
    expect(s.status).toBe('complete');
    const endTotal = s.players.reduce((a, p) => a + p.stack, 0);
    expect(endTotal).toBe(startStacks.reduce((a, b) => a + b, 0));
  });

  it('a min-raise updates the required call amount', () => {
    let s = startHand(config, makeSeats(4), 0, 1, seeded(9));
    const utg = s.toAct;
    s = applyAction(s, { type: 'raise', amount: 4 }); // raise to 4
    expect(s.currentBet).toBe(4);
    const nextLa = getLegalActions(s, s.toAct);
    expect(nextLa.callAmount).toBe(4 - s.players[s.toAct].streetCommitted);
    expect(s.players[utg].streetCommitted).toBe(4);
  });
});
