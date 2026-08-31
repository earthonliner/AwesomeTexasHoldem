import type { GameState } from '../engine/gameTypes';
import type { Street } from '../engine/types';

/** Facts about the current hand's action line, derived from the history. */
export interface LineContext {
  wasAggressorLastStreet: boolean;
  facingCheckRaise: boolean;
  aggressorIsHero: boolean;
  preflopRaised: boolean;
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
  if (prev) {
    let lastAggressorPrev = -1;
    for (const a of game.history) {
      if (a.street === prev && AGGRESSIVE.has(a.type)) lastAggressorPrev = a.playerId;
    }
    wasAggressorLastStreet = lastAggressorPrev === seatId;
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
    facingCheckRaise,
    aggressorIsHero: lastAggressorNow >= 0 && lastAggressorNow === heroId,
    preflopRaised,
  };
}
