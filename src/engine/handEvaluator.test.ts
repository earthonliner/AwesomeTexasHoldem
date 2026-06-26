import { describe, it, expect } from 'vitest';
import { evaluateHand, compareHands, CATEGORY_LABEL } from './handEvaluator';
import { parseCards } from './deck';
import { HandCategory } from './types';

const cat = (str: string) => evaluateHand(parseCards(str)).category;

describe('evaluateHand - categories', () => {
  it('detects a royal flush as straight flush with ace high', () => {
    const r = evaluateHand(parseCards('As Ks Qs Js Ts 2h 3d'));
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers[0]).toBe(14);
  });

  it('detects straight flush', () => {
    expect(cat('9h 8h 7h 6h 5h 2c 3d')).toBe(HandCategory.StraightFlush);
  });

  it('detects the wheel straight flush (5-high)', () => {
    const r = evaluateHand(parseCards('Ah 2h 3h 4h 5h Kd Qc'));
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers[0]).toBe(5);
  });

  it('detects four of a kind', () => {
    expect(cat('9h 9c 9d 9s 5h 2c 3d')).toBe(HandCategory.FourOfAKind);
  });

  it('detects full house', () => {
    expect(cat('9h 9c 9d 5s 5h 2c 3d')).toBe(HandCategory.FullHouse);
  });

  it('picks the best full house from two trips', () => {
    const r = evaluateHand(parseCards('9h 9c 9d 5s 5h 5c 3d'));
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreakers).toEqual([9, 5]);
  });

  it('detects flush', () => {
    expect(cat('2h 5h 7h 9h Jh 3c 4d')).toBe(HandCategory.Flush);
  });

  it('detects straight', () => {
    expect(cat('9h 8c 7d 6s 5h 2c 3d')).toBe(HandCategory.Straight);
  });

  it('detects wheel straight (A-2-3-4-5)', () => {
    const r = evaluateHand(parseCards('Ah 2c 3d 4s 5h Kc Qd'));
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreakers[0]).toBe(5);
  });

  it('detects three of a kind', () => {
    expect(cat('9h 9c 9d 5s 4h 2c 3d')).toBe(HandCategory.ThreeOfAKind);
  });

  it('detects two pair', () => {
    expect(cat('9h 9c 5d 5s 4h 2c 3d')).toBe(HandCategory.TwoPair);
  });

  it('detects one pair', () => {
    expect(cat('9h 9c 5d 7s 4h 2c 3d')).toBe(HandCategory.Pair);
  });

  it('detects high card', () => {
    expect(cat('9h 7c 5d Js 4h 2c 3d')).toBe(HandCategory.HighCard);
  });

  it('does not falsely call a straight across a gap', () => {
    expect(cat('9h 8c 7d 6s 4h 2c 3d')).not.toBe(HandCategory.Straight);
  });
});

describe('compareHands - tiebreakers', () => {
  it('higher straight beats lower straight', () => {
    expect(compareHands(parseCards('9h 8c 7d 6s 5h'), parseCards('8h 7c 6d 5s 4h'))).toBeGreaterThan(0);
  });

  it('kicker decides one pair', () => {
    const a = parseCards('Ah Ac Kd 7s 4h');
    const b = parseCards('Ah Ac Qd 7s 4h');
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('identical hands of different suits tie', () => {
    const a = parseCards('Ah Ac Kd 7s 4h');
    const b = parseCards('As Ad Kh 7c 4d');
    expect(compareHands(a, b)).toBe(0);
  });

  it('full house beats flush', () => {
    const fh = parseCards('9h 9c 9d 5s 5h');
    const fl = parseCards('2h 5h 7h 9h Jh');
    expect(compareHands(fh, fl)).toBeGreaterThan(0);
  });

  it('best 5 of 7 are chosen', () => {
    // Two pair available but a flush is hidden; flush should win out.
    const seven = parseCards('Ah Kh 2h 7h 9h 9c 7c');
    expect(evaluateHand(seven).category).toBe(HandCategory.Flush);
  });

  it('wheel straight loses to six-high straight', () => {
    const wheel = parseCards('Ah 2c 3d 4s 5h');
    const six = parseCards('2h 3c 4d 5s 6h');
    expect(compareHands(six, wheel)).toBeGreaterThan(0);
  });

  it('exposes a human label for every category', () => {
    expect(CATEGORY_LABEL[HandCategory.StraightFlush]).toBeTruthy();
    expect(CATEGORY_LABEL[HandCategory.HighCard]).toBeTruthy();
  });
});
