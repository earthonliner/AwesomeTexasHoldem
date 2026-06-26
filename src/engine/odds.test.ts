import { describe, it, expect } from 'vitest';
import { countOuts, hitProbability, potOdds, requiredEquity, impliedRequiredEquity, callEV } from './odds';
import { parseCards } from './deck';

describe('countOuts', () => {
  it('counts 9 outs for a flush draw', () => {
    const hero = parseCards('Ah Kh');
    const board = parseCards('Qh 2h 7s');
    const { outs } = countOuts(hero, board);
    // 9 hearts complete the flush (improves category from high card / pair).
    expect(outs).toBeGreaterThanOrEqual(9);
  });

  it('counts outs for an open-ended straight draw', () => {
    const hero = parseCards('9h 8c');
    const board = parseCards('7d 6s 2c');
    const { outs } = countOuts(hero, board);
    // Eights tens make the straight (8 cards) plus pair improvements.
    expect(outs).toBeGreaterThanOrEqual(8);
  });
});

describe('hitProbability', () => {
  it('approximates the rule of 4 and 2', () => {
    expect(hitProbability(9, 2)).toBeCloseTo(0.35, 1);
    expect(hitProbability(9, 1)).toBeCloseTo(0.196, 2);
  });

  it('increases with more outs', () => {
    expect(hitProbability(12, 1)).toBeGreaterThan(hitProbability(6, 1));
  });
});

describe('potOdds & EV', () => {
  it('computes pot odds as call / (pot + call)', () => {
    expect(potOdds(100, 50)).toBeCloseTo(50 / 150, 6);
  });

  it('required equity equals pot odds', () => {
    expect(requiredEquity(100, 50)).toBe(potOdds(100, 50));
  });

  it('implied odds lower the required equity', () => {
    const plain = requiredEquity(100, 50);
    const implied = impliedRequiredEquity(100, 50, 200);
    expect(implied).toBeLessThan(plain);
  });

  it('callEV is positive when equity beats pot odds', () => {
    const pot = 100;
    const call = 50;
    const breakeven = requiredEquity(pot, call);
    expect(callEV(breakeven + 0.1, pot, call)).toBeGreaterThan(0);
    expect(callEV(breakeven - 0.1, pot, call)).toBeLessThan(0);
  });
});
