import type { GameState } from '../engine/gameTypes';
import type { Street } from '../engine/types';
import type { PreflopPotType, TablePosition } from './types';

/** Facts about the current hand's action line, derived from the history. */
export interface LineContext {
  wasAggressorLastStreet: boolean;
  /** Someone ELSE drove the previous street (and is now checking to us / not
   * betting) — the classic spot to float / probe / take it away. */
  villainWasAggressorLastStreet: boolean;
  facingCheckRaise: boolean;
  aggressorIsHero: boolean;
  preflopRaised: boolean;
  previousAggressorId: number;
  currentAggressorId: number;
  villainCheckedToMe: boolean;
  checkedThisStreet: boolean;
  streetAggressionCount: number;
  betToPot: number;
  preflopPotType: PreflopPotType;
  preflopRaiseCount: number;
  limpers: number;
  callersAfterRaise: number;
  aggressorPositionFactor: number;
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
    if (!game.players[idx].sittingOut && !game.players[idx].folded) active.push(idx);
  }
  // `active` is clockwise from SB ... ending with the button.
  const order = active.indexOf(seatIdx);
  if (order < 0 || active.length <= 1) return 0.5;
  return order / (active.length - 1);
}

function dealtSeatsClockwise(game: GameState, from: number): number[] {
  const out: number[] = [];
  for (let step = 1; step <= game.players.length; step++) {
    const idx = (from + step) % game.players.length;
    if (!game.players[idx].sittingOut) out.push(idx);
  }
  return out;
}

/** Stable table position for the hand (unlike live relative position, folds do not change it). */
export function tablePositionFor(game: GameState, seatIdx: number): TablePosition {
  const dealt = dealtSeatsClockwise(game, game.buttonIndex);
  if (!dealt.includes(seatIdx)) return 'middle';

  const button = game.buttonIndex;
  if (dealt.length === 2) {
    return seatIdx === button ? 'btn' : 'bb';
  }

  const sb = dealt[0];
  const bb = dealt[1];
  if (seatIdx === button) return 'btn';
  if (seatIdx === sb) return 'sb';
  if (seatIdx === bb) return 'bb';

  const preflopOrder: number[] = [];
  for (let step = 1; step <= game.players.length; step++) {
    const idx = (bb + step) % game.players.length;
    if (
      game.players[idx].sittingOut ||
      idx === button ||
      idx === sb ||
      idx === bb
    ) {
      continue;
    }
    preflopOrder.push(idx);
  }
  const order = preflopOrder.indexOf(seatIdx);
  const fromButton = preflopOrder.length - order;
  if (fromButton <= 1) return 'co';
  if (fromButton === 2) return 'hj';
  if (order === 0) return 'early';
  return 'middle';
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
export function deriveLineContext(
  game: GameState,
  seatIdx: number,
  profiledPlayerIds?: ReadonlySet<number>,
): LineContext {
  const seatId = game.players[seatIdx]?.id ?? seatIdx;
  const profiledIds =
    profiledPlayerIds ??
    new Set(game.players.filter((p) => p.isHero).map((p) => p.id));

  const prev = PREV_STREET[game.street];
  let wasAggressorLastStreet = false;
  let villainWasAggressorLastStreet = false;
  let previousAggressorId = -1;
  if (prev) {
    for (const a of game.history) {
      if (a.street === prev && AGGRESSIVE.has(a.type)) previousAggressorId = a.playerId;
    }
    wasAggressorLastStreet = previousAggressorId === seatId;
    villainWasAggressorLastStreet = previousAggressorId >= 0 && previousAggressorId !== seatId;
  }

  // Current street: find the last aggressor and whether they checked earlier
  // on this same street (a check-raise line).
  let currentAggressorId = -1;
  const checkedThisStreet = new Set<number>();
  let facingCheckRaise = false;
  let streetAggressionCount = 0;
  let betToPot = 0;
  for (const a of game.history) {
    if (a.street !== game.street) continue;
    if (a.type === 'check') checkedThisStreet.add(a.playerId);
    if (AGGRESSIVE.has(a.type)) {
      currentAggressorId = a.playerId;
      streetAggressionCount++;
      if (checkedThisStreet.has(a.playerId)) facingCheckRaise = true;
      else facingCheckRaise = false;
      const wager = a.raiseBy && a.raiseBy > 0 ? a.raiseBy : (a.chipsPutIn ?? a.amount);
      betToPot = a.potBefore > 0 ? wager / a.potBefore : 1;
    }
  }

  const preflop = game.history.filter((a) => a.street === 'preflop');
  const countedRaises = [];
  for (const action of preflop) {
    if (!AGGRESSIVE.has(action.type)) continue;
    // The first wager above the blind establishes a raised pot even when it is
    // a short all-in. Later under-raises change the price but do not create a
    // new 3-bet/4-bet level. Legacy records have no flag and count as before.
    if (countedRaises.length === 0 || action.isFullRaise !== false) {
      countedRaises.push(action);
    }
  }
  const preflopRaiseCount = countedRaises.length;
  const firstRaiseIndex = preflop.findIndex((a) => AGGRESSIVE.has(a.type));
  const lastRaiseIndex = (() => {
    for (let i = preflop.length - 1; i >= 0; i--) {
      if (AGGRESSIVE.has(preflop[i].type)) return i;
    }
    return -1;
  })();
  const limpers = preflop.filter(
    (a, i) => a.type === 'call' && a.toCall <= game.bigBlind && (firstRaiseIndex < 0 || i < firstRaiseIndex),
  ).length;
  const callersAfterRaise =
    lastRaiseIndex < 0 ? 0 : preflop.slice(lastRaiseIndex + 1).filter((a) => a.type === 'call').length;
  const preflopPotType: PreflopPotType =
    preflopRaiseCount >= 3
      ? 'fourBetPlus'
      : preflopRaiseCount === 2
        ? 'threeBet'
        : preflopRaiseCount === 1
          ? 'singleRaised'
          : limpers > 0
            ? 'limped'
            : 'unopened';

  const relevantAggressor = currentAggressorId >= 0 ? currentAggressorId : previousAggressorId;
  const aggressorIdx = game.players.findIndex((p) => p.id === relevantAggressor);
  const aggressorPositionFactor =
    aggressorIdx >= 0 ? positionFactorFor(game, aggressorIdx) : 0.5;

  return {
    wasAggressorLastStreet,
    villainWasAggressorLastStreet,
    facingCheckRaise,
    aggressorIsHero: relevantAggressor >= 0 && profiledIds.has(relevantAggressor),
    preflopRaised: preflopRaiseCount > 0,
    previousAggressorId,
    currentAggressorId,
    villainCheckedToMe:
      previousAggressorId >= 0 &&
      previousAggressorId !== seatId &&
      checkedThisStreet.has(previousAggressorId),
    checkedThisStreet: checkedThisStreet.has(seatId),
    streetAggressionCount,
    betToPot,
    preflopPotType,
    preflopRaiseCount,
    limpers,
    callersAfterRaise,
    aggressorPositionFactor,
  };
}
