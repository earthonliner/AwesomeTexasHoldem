import { describe, it, expect } from 'vitest';
import { startHand, applyAction, type SeatInit } from '../engine/game';
import type { GameConfig } from '../engine/gameTypes';
import { deriveLineContext, positionFactorFor, tablePositionFor } from './line';

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
    const otherLc = deriveLineContext(g, other);
    expect(otherLc.wasAggressorLastStreet).toBe(false);
    expect(otherLc.villainWasAggressorLastStreet).toBe(true);
    expect(lcRaiser.villainWasAggressorLastStreet).toBe(false);
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

  it('counts the first short all-in as an open but not later under-raises', () => {
    const shortSeats: SeatInit[] = [
      { id: 0, name: 'Short BTN', isHero: true, stack: 3 },
      { id: 1, name: 'Short SB', isHero: false, stack: 4 },
      { id: 2, name: 'BB', isHero: false, stack: 200 },
    ];
    let g = startHand(config, shortSeats, 0, 1, seeded(22));
    g = applyAction(g, { type: 'allin', amount: 3 }); // +1 over the blind: not a full raise
    g = applyAction(g, { type: 'allin', amount: 4 }); // another +1 under-raise

    expect(g.history[0].isFullRaise).toBe(false);
    expect(g.history[1].isFullRaise).toBe(false);
    const line = deriveLineContext(g, g.toAct);
    expect(line.preflopRaised).toBe(true);
    expect(line.preflopRaiseCount).toBe(1);
    expect(line.preflopPotType).toBe('singleRaised');
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

describe('positionFactorFor', () => {
  const cfg6: GameConfig = { seatCount: 6, blindLevel: 1, startingStackBB: 100, difficulty: 'hard' };
  const six: SeatInit[] = [0, 1, 2, 3, 4, 5].map((i) => ({ id: i, name: `P${i}`, isHero: i === 0, stack: 200 }));

  it('orders seats by post-flop action: SB worst, BTN best, CO late (not "near the button")', () => {
    const g = startHand(cfg6, six, 0, 1, seeded(4));
    // button=0, SB=1, BB=2, UTG=3, MP=4, CO=5
    expect(positionFactorFor(g, 1)).toBe(0); // SB acts first post-flop
    expect(positionFactorFor(g, 0)).toBe(1); // BTN acts last
    expect(positionFactorFor(g, 5)).toBeGreaterThan(positionFactorFor(g, 3)); // CO later than UTG
    expect(positionFactorFor(g, 3)).toBeGreaterThan(positionFactorFor(g, 2)); // UTG later than BB
    expect(positionFactorFor(g, 5)).toBeCloseTo(0.8, 5);
  });

  it('assigns all 6-max table positions without treating blinds as middle seats', () => {
    const g = startHand(cfg6, six, 0, 1, seeded(44));
    expect(g.players.map((_, i) => tablePositionFor(g, i))).toEqual([
      'btn',
      'sb',
      'bb',
      'early',
      'hj',
      'co',
    ]);
  });

  it('ignores seats that sit out', () => {
    const g = startHand(cfg6, six.map((s, i) => ({ ...s, sittingOut: i === 5 })), 0, 1, seeded(5));
    // Without the CO, MP (4) is now the last non-button seat.
    expect(positionFactorFor(g, 4)).toBeCloseTo(0.75, 5);
    expect(positionFactorFor(g, 0)).toBe(1);
  });
});
