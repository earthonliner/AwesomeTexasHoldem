import { describe, it, expect } from 'vitest';
import { parseCards } from '../engine/deck';
import type { Card } from '../engine/types';
import {
  fiveBetProbability,
  jamContinueFraction,
  openJamWidth,
  shortStackOpenMultiplier,
  shoveRangeFraction,
  valueFourBetProbability,
} from './preflopRanges';

const hand = (s: string) => parseCards(s) as [Card, Card];

describe('shove range by wager size', () => {
  it('has no cliffs at the old depth buckets', () => {
    for (const edge of [18, 30, 55]) {
      expect(Math.abs(shoveRangeFraction(edge - 0.01) - shoveRangeFraction(edge))).toBeLessThan(0.002);
    }
  });

  it('tightens monotonically as the jam grows and clamps at the ends', () => {
    let prev = shoveRangeFraction(5);
    for (let bb = 6; bb <= 120; bb += 1) {
      const next = shoveRangeFraction(bb);
      expect(next).toBeLessThanOrEqual(prev + 1e-9);
      prev = next;
    }
    expect(shoveRangeFraction(3)).toBe(shoveRangeFraction(6));
    expect(shoveRangeFraction(200)).toBe(shoveRangeFraction(90));
  });
});

describe('short-stack opening', () => {
  it('open-jams far wider with only the blinds behind than from early position', () => {
    expect(openJamWidth(1)).toBeGreaterThan(1.8);
    expect(openJamWidth(2)).toBeGreaterThan(openJamWidth(3));
    expect(openJamWidth(5)).toBe(1);
    expect(openJamWidth(8)).toBe(1);
  });

  it('tightens raise-first-in gradually below ~25BB and is neutral at 100BB', () => {
    expect(shortStackOpenMultiplier(100)).toBe(1);
    expect(shortStackOpenMultiplier(25)).toBeLessThan(1);
    expect(shortStackOpenMultiplier(15)).toBeLessThan(shortStackOpenMultiplier(25));
    expect(shortStackOpenMultiplier(5)).toBeGreaterThanOrEqual(0.72);
  });
});

describe('explicit 4-bet / 5-bet value classes', () => {
  it('always 4-bets AA/KK for value and never 4-bets KQs or AJs for value', () => {
    for (const pressure of [0, 0.5, 1]) {
      expect(valueFourBetProbability(hand('As Ad'), pressure, 0)).toBe(1);
      expect(valueFourBetProbability(hand('Ks Kd'), pressure, 0)).toBe(1);
      expect(valueFourBetProbability(hand('Kh Qh'), pressure, 0)).toBe(0);
      expect(valueFourBetProbability(hand('Ah Jh'), pressure, 0)).toBe(0);
    }
  });

  it('stacks off JJ/TT only when shallow while AK stays a jam candidate', () => {
    expect(valueFourBetProbability(hand('Jh Jd'), 1, 0)).toBeGreaterThan(
      valueFourBetProbability(hand('Jh Jd'), 0, 1),
    );
    expect(fiveBetProbability(hand('Th Td'), 0, 1)).toBe(0);
    expect(fiveBetProbability(hand('Th Td'), 1, 0)).toBeGreaterThan(0);
    expect(fiveBetProbability(hand('Ah Kd'), 0, 1)).toBeGreaterThan(0.1);
  });

  it('assumes fewer hands continue against a bigger jam', () => {
    expect(jamContinueFraction(100, 30)).toBeLessThan(jamContinueFraction(40, 30));
    expect(jamContinueFraction(40, 30)).toBeLessThanOrEqual(0.65);
    expect(jamContinueFraction(400, 30)).toBeGreaterThanOrEqual(0.25);
  });
});
