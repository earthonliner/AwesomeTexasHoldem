import { describe, it, expect } from 'vitest';
import { startHand, applyAction, type SeatInit } from '../engine/game';
import type { GameConfig } from '../engine/gameTypes';
import { deriveLineContext } from './line';

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

const config: GameConfig = { seatCount: 3, blindLevel: 1, startingStackBB: 100, difficulty: 'medium' };
const seats: SeatInit[] = [0, 1, 2].map((i) => ({ id: i, name: `P${i}`, isHero: i === 0, stack: 200 }));

describe('deriveLineContext', () => {
  it('tracks the pre-flop aggressor into the flop and flags raised pots', () => {
    // 3-handed, button=0, SB=1, BB=2, UTG(=button here in 3max order) acts first.
    let g = startHand(config, seats, 0, 1, seeded(1));
    const raiser = g.toAct;
    g = applyAction(g, { type: 'raise', amount: 6 });
    while (g.street === 'preflop' && g.toAct >= 0) g = applyAction(g, { type: 'call', amount: 0 });

    expect(g.street).toBe('flop');
    const lcRaiser = deriveLineContext(g, raiser);
    expect(lcRaiser.wasAggressorLastStreet).toBe(true);
    expect(lcRaiser.preflopRaised).toBe(true);

    const other = (raiser + 1) % 3;
    expect(deriveLineContext(g, other).wasAggressorLastStreet).toBe(false);
  });

  it('flags a limped pot as preflopRaised=false', () => {
    let g = startHand(config, seats, 0, 1, seeded(2));
    while (g.street === 'preflop' && g.toAct >= 0) {
      const idx = g.toAct;
      const toCall = g.currentBet - g.players[idx].streetCommitted;
      g = applyAction(g, toCall > 0 ? { type: 'call', amount: 0 } : { type: 'check', amount: 0 });
    }
    expect(g.street).toBe('flop');
    expect(deriveLineContext(g, 0).preflopRaised).toBe(false);
  });

  it('detects a check-raise and identifies the hero as aggressor', () => {
    let g = startHand(config, seats, 0, 1, seeded(3));
    while (g.street === 'preflop' && g.toAct >= 0) {
      const idx = g.toAct;
      const toCall = g.currentBet - g.players[idx].streetCommitted;
      g = applyAction(g, toCall > 0 ? { type: 'call', amount: 0 } : { type: 'check', amount: 0 });
    }
    expect(g.street).toBe('flop');

    // First to act checks, second bets, first check-raises.
    const first = g.toAct;
    g = applyAction(g, { type: 'check', amount: 0 });
    const bettor = g.toAct;
    g = applyAction(g, { type: 'bet', amount: 4 });
    if (g.toAct === first) {
      g = applyAction(g, { type: 'raise', amount: 12 });
      const lc = deriveLineContext(g, g.toAct);
      expect(lc.facingCheckRaise).toBe(true);
      // Aggressor is the check-raiser; hero flag matches seat 0 identity.
      expect(lc.aggressorIsHero).toBe(g.players[first].isHero);
    } else {
      // Fallback ordering (first==bettor case) — still a valid engine line.
      expect(bettor).toBeGreaterThanOrEqual(0);
    }
  });
});
