import type { GameState } from '../engine/gameTypes';

/**
 * An AI's own table image, tracked on two time scales.
 *
 * The old single EMA (0.65 / 0.35) had a half-life of ~1.6 hands, so the
 * "image" only described the last couple of hands. Opponents form an
 * impression over a session, and they mostly remember what they SAW: an
 * aggressive hand that ended at showdown weighs more than one that was folded
 * to unseen. Both tracks only move on hands with a real post-flop or
 * pre-flop aggressive opportunity, so a stretch of pre-flop folds leaves the
 * image alone instead of dragging it towards a default.
 */
export interface TableImage {
  /** What the table saw in the last few hands (half-life ≈ 1.6 hands). */
  short: number;
  /** Session-level impression (half-life ≈ 8 hands). */
  long: number;
  /** Hands with at least one aggressive opportunity observed so far. */
  opportunities: number;
}

export const DEFAULT_IMAGE = 0.3;
const SHORT_KEEP = 0.65;
const LONG_KEEP = 0.92;
/** Opportunities after which the long track carries half of its full weight. */
const LONG_CONFIDENCE_HANDS = 12;

export function initialTableImage(): TableImage {
  return { short: DEFAULT_IMAGE, long: DEFAULT_IMAGE, opportunities: 0 };
}

export interface HandImageSample {
  aggressive: number;
  passive: number;
  /** The player's cards were revealed at showdown. */
  shown: boolean;
  /** The player won chips from the hand (used only when `shown`). */
  won: boolean;
}

/** Collect the image-relevant facts about one player's finished hand. */
export function sampleHandImage(game: GameState, playerId: number): HandImageSample {
  let aggressive = 0;
  let passive = 0;
  for (const a of game.history) {
    if (a.playerId !== playerId) continue;
    if (a.type === 'bet' || a.type === 'raise' || a.type === 'allin') aggressive++;
    if (a.type === 'call' || a.type === 'check') passive++;
  }
  const shown = game.revealed.includes(playerId);
  const won = game.payouts.some((p) => p.playerId === playerId && p.amount > 0);
  return { aggressive, passive, shown, won };
}

/**
 * Fold one finished hand into the image. Aggression that was shown down and
 * lost is what opponents remember as "a bluff", so it counts fully; shown-down
 * aggression that won reads as "they had it" and is discounted.
 */
export function updateTableImage(prev: TableImage | undefined, hand: HandImageSample): TableImage {
  const base = prev ?? initialTableImage();
  const actions = hand.aggressive + hand.passive;
  if (actions === 0) return base;
  let x = hand.aggressive / actions;
  if (hand.shown && hand.aggressive > 0) x = hand.won ? x * 0.7 : Math.min(1, x + 0.25);
  return {
    short: SHORT_KEEP * base.short + (1 - SHORT_KEEP) * x,
    long: LONG_KEEP * base.long + (1 - LONG_KEEP) * x,
    opportunities: base.opportunities + 1,
  };
}

/**
 * The single 0..1 image the decision layer consumes. Early in a session the
 * long track has seen too little to mean much, so the short track dominates;
 * as opportunities accumulate the session impression takes over.
 */
export function effectiveImage(image: TableImage | undefined): number {
  if (!image) return DEFAULT_IMAGE;
  const trust = image.opportunities / (image.opportunities + LONG_CONFIDENCE_HANDS);
  const longWeight = 0.25 + 0.5 * trust;
  return (1 - longWeight) * image.short + longWeight * image.long;
}
