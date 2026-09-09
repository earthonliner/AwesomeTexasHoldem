import type { GameState } from '../engine/gameTypes';
import type { Street } from '../engine/types';

/** Facts about the current hand's action line, derived from the history. */
export interface LineContext {
  wasAggressorLastStreet: boolean;
  /** Someone ELSE drove the previous street (and is now checking to us / not
   * betting) — the classic spot to float / probe / take it away. */
  villainWasAggressorLastStreet: boolean;
  facingCheckRaise: boolean;
  aggressorIsHero: boolean;
  preflopRaised: boolean;
}

/**
 * Post-flop positional advantage in 0..1 (SB = 0 acts first, BTN = 1 acts
 * last), computed from seats still dealt in. Note this is NOT "distance from
 * the button": the blinds sit right next to the button yet act FIRST post-flop,
 * while the cutoff sits far from it yet acts second-to-last.
 */
export function positionFactorFor(game: GameState, seatIdx: number): number {
  const n = game.players.length;
  const active: number[] = [];
  for (let step = 1; step <= n; step++) {
    const idx = (game.buttonIndex + step) % n;
    if (!game.players[idx].sittingOut) active.push(idx);
  }
  // `active` is clockwise from SB ... ending with the button.
  const order = active.indexOf(seatIdx);
  if (order < 0 || active.length <= 1) return 0.5;
  return order / (active.length - 1);
}

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
const PREV_STREET: Partial<Record<Street, Street>> = {
  flop: 'preflop',
  turn: 'flop',
  river: 'turn',
};

/**
 * Derive the hand's story line for the player at `seatIdx` from the recorded
 * action history — who drove the previous street, whether the current bet is a
 * check-raise, whether the pot was ever raised pre-flop, and whether the
 * current street's aggressor is the human hero. Pure and side-effect free so
 * the same helper serves the single-player store, the LAN server and tests.
 */
export function deriveLineContext(game: GameState, seatIdx: number): LineContext {
  const seatId = game.players[seatIdx]?.id ?? seatIdx;
  const heroId = game.players.find((p) => p.isHero)?.id ?? -1;

  const prev = PREV_STREET[game.street];
  let wasAggressorLastStreet = false;
  let villainWasAggressorLastStreet = false;
  if (prev) {
    let lastAggressorPrev = -1;
    for (const a of game.history) {
      if (a.street === prev && AGGRESSIVE.has(a.type)) lastAggressorPrev = a.playerId;
    }
    wasAggressorLastStreet = lastAggressorPrev === seatId;
    villainWasAggressorLastStreet = lastAggressorPrev >= 0 && lastAggressorPrev !== seatId;
  }

  // Current street: find the last aggressor and whether they checked earlier
  // on this same street (a check-raise line).
  let lastAggressorNow = -1;
  const checkedThisStreet = new Set<number>();
  let facingCheckRaise = false;
  for (const a of game.history) {
    if (a.street !== game.street) continue;
    if (a.type === 'check') checkedThisStreet.add(a.playerId);
    if (AGGRESSIVE.has(a.type)) {
      lastAggressorNow = a.playerId;
      if (checkedThisStreet.has(a.playerId)) facingCheckRaise = true;
      else facingCheckRaise = false;
    }
  }

  const preflopRaised = game.history.some(
    (a) => a.street === 'preflop' && (a.type === 'raise' || a.type === 'allin'),
  );

  return {
    wasAggressorLastStreet,
    villainWasAggressorLastStreet,
    facingCheckRaise,
    aggressorIsHero: lastAggressorNow >= 0 && lastAggressorNow === heroId,
    preflopRaised,
  };
}
