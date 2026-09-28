import { getLegalActions, totalPot } from '../engine/game';
import type { GameState } from '../engine/gameTypes';
import { buildPots } from '../engine/sidePots';
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

/**
 * Prefer the profile of the player responsible for the current line. With no
 * such player, a sole profiled opponent is only unambiguous heads-up; in a
 * multiway pot their tendencies must not leak into AI-vs-AI decisions.
 */
export function resolveProfiledOpponentId(
  lineProfiledId: number | undefined,
  liveOpponents: number,
  liveProfiledIds: readonly number[],
): number | undefined {
  if (lineProfiledId !== undefined) return lineProfiledId;
  return liveOpponents === 1 && liveProfiledIds.length === 1
    ? liveProfiledIds[0]
    : undefined;
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
  const actedThisStreet = new Set(
    game.history
      .filter((action) => action.street === game.street)
      .map((action) => action.playerId),
  );
  const relevantAggressorId =
    line.currentAggressorId >= 0 ? line.currentAggressorId : line.previousAggressorId;
  // Chips an opponent can still put in against us. An all-in aggressor has
  // none behind: the remaining betting is with whoever still has chips.
  const contest = (p: GameState['players'][number]) =>
    p.stack + Math.max(0, p.streetCommitted - player.streetCommitted);
  const aggressorOpponent = liveOpponentIndices.find(({ p }) => p.id === relevantAggressorId)?.p;
  const deepestOpponent = liveOpponentIndices
    .map(({ p }) => p)
    .sort((a, b) => contest(b) - contest(a))[0];
  const stackOpponent =
    aggressorOpponent && !aggressorOpponent.allIn ? aggressorOpponent : deepestOpponent;
  const effectiveStack = Math.min(player.stack, stackOpponent ? contest(stackOpponent) : player.stack);
  const positionFactor = positionFactorFor(game, idx);
  const aggressorIdx = game.players.findIndex((p) => p.id === relevantAggressorId);
  const aggressorPosition =
    aggressorIdx >= 0 ? positionFactorFor(game, aggressorIdx) : line.aggressorPositionFactor;
  const aggressorCanAct =
    aggressorIdx >= 0 && !game.players[aggressorIdx].folded && !game.players[aggressorIdx].allIn;
  const actingOpponents = liveOpponentIndices.filter(({ p }) => !p.allIn);
  const preflopAggressorIdx = game.players.findIndex((p) => p.id === line.preflopAggressorId);
  // The range model follows an opponent who can still act; an all-in player's
  // range only matters at showdown.
  const byRangePreference = (pool: typeof liveOpponentIndices) =>
    pool.find(({ p }) => p.id === relevantAggressorId) ??
    pool.find(({ p }) => p.id === line.preflopAggressorId) ??
    pool.find(({ i }) => tablePositionFor(game, i) === 'bb') ??
    pool.find(({ i }) => tablePositionFor(game, i) === 'sb') ??
    pool[0];
  const rangeOpponent = byRangePreference(actingOpponents) ?? byRangePreference(liveOpponentIndices);

  // Pot layers, counting our call: the part we can win at all, and the part
  // that all-in opponents contest as well (they can neither fold nor add to it).
  const call = Math.max(0, Math.min(game.currentBet - player.streetCommitted, player.stack));
  const pots = buildPots(
    game.players.map((p) => ({
      playerId: p.id,
      contributed: p.totalCommitted + (p.id === player.id ? call : 0),
      folded: p.folded || p.sittingOut,
    })),
  ).filter((pot) => pot.eligible.includes(player.id));
  const allInOpponents = liveOpponentIndices.filter(({ p }) => p.allIn).map(({ p }) => p);
  const allInIds = new Set(allInOpponents.map((p) => p.id));
  const idleAllIn = allInOpponents.filter((p) => !actedThisStreet.has(p.id));
  const committedAfterFlop = (id: number) => {
    const last = [...game.history].reverse().find((a) => a.playerId === id);
    return !!last && last.street !== 'preflop';
  };
  const currentAggressor = liveOpponentIndices.find(({ p }) => p.id === line.currentAggressorId)?.p;
  const profiledIds =
    meta.profiledPlayerIds ?? new Set(game.players.filter((p) => p.isHero).map((p) => p.id));

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
    playersBehind: liveOpponentIndices.filter(
      ({ p }) => !actedThisStreet.has(p.id) && !p.allIn,
    ).length,
    committedOpponents: liveOpponentIndices.filter(
      ({ p }) => p.allIn || (game.currentBet > 0 && p.streetCommitted >= game.currentBet),
    ).length,
    winnablePot: pots.reduce((sum, pot) => sum + pot.amount, 0),
    allIn:
      allInOpponents.length > 0
        ? {
            opponents: allInOpponents.length,
            idle: idleAllIn.length,
            idleShare: idleAllIn.some((p) => committedAfterFlop(p.id)) ? 0.5 : 1,
            bettor: !!currentAggressor?.allIn,
            callers: allInOpponents.filter(
              (p) => actedThisStreet.has(p.id) && p.id !== line.currentAggressorId,
            ).length,
            pot: pots
              .filter((pot) => pot.eligible.some((id) => allInIds.has(id)))
              .reduce((sum, pot) => sum + pot.amount, 0),
            aggressor: !!aggressorOpponent?.allIn,
          }
        : undefined,
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
    inPositionVsAggressor: aggressorCanAct
      ? positionFactor > aggressorPosition
      : aggressorIdx >= 0 && actingOpponents.length > 0
        ? actingOpponents.every(({ i }) => positionFactor > positionFactorFor(game, i))
        : positionFactor >= 0.6,
    aggressorPosition: aggressorIdx >= 0 ? tablePositionFor(game, aggressorIdx) : undefined,
    preflopAggressorPosition:
      preflopAggressorIdx >= 0 ? tablePositionFor(game, preflopAggressorIdx) : undefined,
    rangeOpponentPosition: rangeOpponent ? tablePositionFor(game, rangeOpponent.i) : undefined,
    rangeOpponentRaisedPreflop: rangeOpponent
      ? rangeOpponent.p.id === line.preflopAggressorId
      : undefined,
    rangeOpponentIsProfiled: rangeOpponent ? profiledIds.has(rangeOpponent.p.id) : undefined,
    myBluffsThisHand: meta.bluffCount ?? 0,
    bluffedLastStreet:
      meta.lastBluffStreet !== undefined &&
      meta.lastBluffStreet === PREVIOUS_STREET[game.street],
  };
}
