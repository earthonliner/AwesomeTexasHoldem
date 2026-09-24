import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IMAGE,
  effectiveImage,
  initialTableImage,
  updateTableImage,
  type HandImageSample,
} from './image';

const aggressiveHand: HandImageSample = { aggressive: 3, passive: 0, shown: false, won: false };
const passiveHand: HandImageSample = { aggressive: 0, passive: 3, shown: false, won: false };

describe('two-track table image', () => {
  it('ignores hands without an aggressive opportunity', () => {
    const start = initialTableImage();
    const next = updateTableImage(start, { aggressive: 0, passive: 0, shown: false, won: false });
    expect(next).toEqual(start);
    expect(effectiveImage(undefined)).toBe(DEFAULT_IMAGE);
  });

  it('moves the short track quickly and the long track slowly', () => {
    const once = updateTableImage(undefined, aggressiveHand);
    expect(once.short).toBeGreaterThan(once.long);
    expect(once.long).toBeGreaterThan(DEFAULT_IMAGE);

    let image = once;
    for (let i = 0; i < 3; i++) image = updateTableImage(image, passiveHand);
    // Three quiet hands almost erase the short-term memory of the aggression,
    // while the session impression still remembers it (a purely passive
    // sequence would have decayed the long track to ~0.215).
    expect(image.short).toBeLessThan(0.15);
    expect(image.long).toBeGreaterThan(image.short + 0.1);
    expect(image.long).toBeGreaterThan(0.25);
  });

  it('remembers a shown-down losing bluff more than unseen aggression', () => {
    const unseen = updateTableImage(undefined, { aggressive: 1, passive: 1, shown: false, won: false });
    const caught = updateTableImage(undefined, { aggressive: 1, passive: 1, shown: true, won: false });
    const hadIt = updateTableImage(undefined, { aggressive: 1, passive: 1, shown: true, won: true });
    expect(caught.short).toBeGreaterThan(unseen.short);
    expect(hadIt.short).toBeLessThan(unseen.short);
  });

  it('trusts the session track more as opportunities accumulate', () => {
    const fresh = { short: 0.8, long: 0.2, opportunities: 1 };
    const seasoned = { short: 0.8, long: 0.2, opportunities: 60 };
    expect(effectiveImage(fresh)).toBeGreaterThan(effectiveImage(seasoned));
    expect(effectiveImage(seasoned)).toBeLessThan(0.5);
  });
});
