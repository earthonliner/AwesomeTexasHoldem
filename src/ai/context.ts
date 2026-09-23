import { getLegalActions, totalPot } from '../engine/game';
import type { GameState } from '../engine/gameTypes';
import type { Card, Street } from '../engine/types';
import { deriveLineContext, positionFactorFor, tablePositionFor } from './line';
import type { DecisionContext } from './types';

export interface ContextMeta {
  recentImage?: number;
  bluffCount?: number;
  lastBluffStreet?: Street;
  /** Human/player ids for whom an exploit profile may be supplied. */
  profiledPlayerIds?: ReadonlySet<number>;
}

const PREVIOUS_STREET: Partial<Record<Street, Street>> = {
  flop: 'preflop',
  turn: 'flop',
  river: 'turn',
};

/**
 * Build the complete AI context in one shared place so local and LAN games
 * cannot silently diverge.
 */
export function buildDecisionContext(
  game: GameState,
  idx: number,
  meta: ContextMeta = {},
): DecisionContext {
  const player = game.players[idx];
  const legal = getLegalActions(game, idx);
  const liveOpponentIndices = game.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.folded && !p.sittingOut && p.id !== player.id);
  const line = deriveLineContext(game, idx, meta.profiledPlayerIds);
  const relevantAggressorId =
    line.currentAggressorId >= 0 ? line.currentAggressorId : line.previousAggressorId;
  const relevantOpponent =
    game.players.find((p) => p.id === relevantAggressorId) ??
    liveOpponentIndices
      .map(({ p }) => p)
      .sort((a, b) => b.stack + b.totalCommitted - (a.stack + a.totalCommitted))[0];

  const amountOpponentCanStillContest = relevantOpponent
    ? relevantOpponent.stack +
      Math.max(0, relevantOpponent.streetCommitted - player.streetCommitted)
    : player.stack;
  const effectiveStack = Math.min(player.stack, amountOpponentCanStillContest);
  const positionFactor = positionFactorFor(game, idx);
  const aggressorIdx = game.players.findIndex((p) => p.id === relevantAggressorId);
  const aggressorPosition =
    aggressorIdx >= 0 ? positionFactorFor(game, aggressorIdx) : line.aggressorPositionFactor;

  return {
    hole: player.hole as [Card, Card],
    board: [...game.board],
    liveOpponents: Math.max(1, liveOpponentIndices.length),
    potBefore: totalPot(game),
    toCall: game.currentBet - player.streetCommitted,
    stack: player.stack,
    effectiveStack,
    bigBlind: game.bigBlind,
    positionFactor,
    position: tablePositionFor(game, idx),
    tableSize: game.players.filter((p) => !p.sittingOut).length,
    playersBehind: liveOpponentIndices.filter(({ p }) => !p.hasActed && !p.allIn).length,
    street: game.street as DecisionContext['street'],
    canCheck: legal.canCheck,
    canRaise: legal.canBet || legal.canRaise,
    currentBet: game.currentBet,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    streetCommitted: player.streetCommitted,
    totalCommitted: player.totalCommitted,
    recentImage: meta.recentImage ?? 0.3,
    ...line,
    profiledPlayerId:
      relevantAggressorId >= 0 && meta.profiledPlayerIds?.has(relevantAggressorId)
        ? relevantAggressorId
        : undefined,
    inPositionVsAggressor:
      aggressorIdx >= 0 ? positionFactor > aggressorPosition : positionFactor >= 0.6,
    myBluffsThisHand: meta.bluffCount ?? 0,
    bluffedLastStreet:
      meta.lastBluffStreet !== undefined &&
      meta.lastBluffStreet === PREVIOUS_STREET[game.street],
  };
}
