import { describe, it, expect } from 'vitest';
import { parseCards } from './deck';
import type { Card } from './types';
import {
  PLAYABILITY_ORDER,
  preflopAllInPercentile,
  preflopAllInScore,
  preflopPercentile,
  preflopScore,
  startingHandClass,
} from './preflopStrength';

const hand = (s: string) => parseCards(s) as [Card, Card];
const play = (s: string) => preflopScore(...hand(s));
const allIn = (s: string) => preflopAllInScore(...hand(s));

describe('pre-flop playability ordering', () => {
  it('lists every one of the 169 starting-hand classes exactly once', () => {
    expect(PLAYABILITY_ORDER).toHaveLength(169);
    expect(new Set(PLAYABILITY_ORDER).size).toBe(169);
    expect(PLAYABILITY_ORDER).toContain(startingHandClass(...hand('7h 2d')));
  });

  it('never ranks AKs above AA (the audited distortion)', () => {
    expect(play('As Ad')).toBeGreaterThan(play('Ah Kh'));
    expect(play('Ks Kd')).toBeGreaterThan(play('Ah Kh'));
    expect(play('Qs Qd')).toBeGreaterThan(play('Ah Kh'));
    expect(play('Js Jd')).toBeGreaterThan(play('Ah Qh'));
    expect(play('Ts Td')).toBeGreaterThan(play('Ah Qh'));
  });

  it('keeps the usual playability relations', () => {
    expect(play('Ah Kh')).toBeGreaterThan(play('Ah Kd'));
    expect(play('Ah Kd')).toBeGreaterThan(play('Ah Qd'));
    expect(play('7h 6h')).toBeGreaterThan(play('7h 2d'));
    expect(play('Ah 5h')).toBeGreaterThan(play('Ah 8d'));
  });

  it('percentiles lie in (0, 1] and follow the ordering', () => {
    expect(preflopPercentile(...hand('As Ad'))).toBe(1);
    expect(preflopPercentile(...hand('7h 2d'))).toBeGreaterThan(0);
    expect(preflopPercentile(...hand('Ah Kh'))).toBeGreaterThan(preflopPercentile(...hand('Ah Qh')));
  });
});

describe('pre-flop all-in ordering', () => {
  it('ranks by raw equity: pairs and high cards, not suited connectors', () => {
    expect(allIn('As Ad')).toBeGreaterThan(allIn('Ks Kd'));
    expect(allIn('Ks Kd')).toBeGreaterThan(allIn('Ah Kh'));
    expect(allIn('Js Jd')).toBeGreaterThan(allIn('Ah Kh'));
    expect(allIn('Ah 5h')).toBeGreaterThan(allIn('7h 6h'));
    expect(allIn('Kh Qd')).toBeGreaterThan(allIn('7h 6h'));
  });

  it('disagrees with the playability ordering where they should differ', () => {
    // 76s is a fine opening hand but a poor hand to get it in with; a small
    // pair is the opposite.
    const playable = preflopPercentile(...hand('7h 6h'));
    const pair = preflopPercentile(...hand('2h 2d'));
    expect(Math.abs(playable - pair)).toBeLessThan(0.05);
    expect(preflopAllInPercentile(...hand('2h 2d'))).toBeGreaterThan(
      preflopAllInPercentile(...hand('7h 6h')) + 0.15,
    );
  });
});
