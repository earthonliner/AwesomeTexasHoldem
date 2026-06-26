import { describe, it, expect } from 'vitest';
import { estimateEquity } from './monteCarlo';
import { parseCards } from './deck';
import type { Card } from './types';

/** Deterministic mulberry32 PRNG so equity tests are reproducible. */
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

const hero = (s: string) => parseCards(s) as [Card, Card];

describe('estimateEquity', () => {
  it('rates pocket aces very strong heads-up preflop', () => {
    const r = estimateEquity({
      heroCards: hero('As Ad'),
      opponents: 1,
      iterations: 4000,
      rng: seeded(1),
    });
    expect(r.win).toBeGreaterThan(0.8);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 5);
  });

  it('rates 7-2 offsuit weak heads-up preflop', () => {
    const r = estimateEquity({
      heroCards: hero('7s 2d'),
      opponents: 1,
      iterations: 4000,
      rng: seeded(2),
    });
    expect(r.win).toBeLessThan(0.4);
  });

  it('equity falls as opponent count rises', () => {
    const oneOpp = estimateEquity({ heroCards: hero('As Ad'), opponents: 1, iterations: 3000, rng: seeded(3) });
    const fiveOpp = estimateEquity({ heroCards: hero('As Ad'), opponents: 5, iterations: 3000, rng: seeded(4) });
    expect(fiveOpp.win).toBeLessThan(oneOpp.win);
  });

  it('recognizes an unbeatable made hand on the board', () => {
    const r = estimateEquity({
      heroCards: hero('As Ks'),
      board: parseCards('Qs Js Ts'),
      opponents: 1,
      iterations: 3000,
      rng: seeded(5),
    });
    // Royal flush already made -> hero can never lose.
    expect(r.win + r.tie).toBe(1);
  });

  it('is reproducible with the same seed', () => {
    const a = estimateEquity({ heroCards: hero('Ts Td'), opponents: 2, iterations: 2000, rng: seeded(7) });
    const b = estimateEquity({ heroCards: hero('Ts Td'), opponents: 2, iterations: 2000, rng: seeded(7) });
    expect(a.win).toBe(b.win);
  });

  it('range mode lowers hero equity vs random mode (tougher opponents)', () => {
    const random = estimateEquity({ heroCards: hero('Ks Kd'), opponents: 3, iterations: 3000, rng: seeded(9), mode: 'random' });
    const range = estimateEquity({ heroCards: hero('Ks Kd'), opponents: 3, iterations: 3000, rng: seeded(9), mode: 'range' });
    expect(range.win).toBeLessThanOrEqual(random.win + 0.02);
  });
});
