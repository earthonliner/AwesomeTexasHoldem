import { describe, expect, it } from 'vitest';
import { parseCards } from '../engine/deck';
import type { Card } from '../engine/types';
import { analyseHand } from './handFeatures';

const hole = (text: string) => parseCards(text) as [Card, Card];

describe('analyseHand', () => {
  it('recognises nut flush and open-ended straight draws', () => {
    const nutFlush = analyseHand(hole('Ah 9h'), parseCards('Kh 5h 2c'));
    expect(nutFlush.flushDraw).toBe(true);
    expect(nutFlush.nutFlushDraw).toBe(true);

    const openEnded = analyseHand(hole('8s 7s'), parseCards('Kh 9c 6d'));
    expect(openEnded.straightDraw).toBe(true);
    expect(openEnded.openEnded).toBe(true);
    expect(openEnded.bluffQuality).toBeGreaterThan(0.3);
  });

  it('prefers a nut blocker over unblocking air on the river', () => {
    const board = parseCards('Qh 9h 4h 3c 2d');
    const blocker = analyseHand(hole('Ah 7s'), board);
    const air = analyseHand(hole('Kc 7s'), board);
    expect(blocker.blockerScore).toBeGreaterThan(air.blockerScore);
    expect(blocker.bluffQuality).toBeGreaterThan(air.bluffQuality);
  });
});
