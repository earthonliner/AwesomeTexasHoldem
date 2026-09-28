/**
 * Scripted opponents for evaluating the hard AI. Each one exaggerates a leak a
 * strong live player would spot and punish; none of them adapts.
 */
import { getLegalActions, totalPot } from '../../src/engine/game';
import type { GameState } from '../../src/engine/gameTypes';
import { evaluateHand } from '../../src/engine/handEvaluator';
import { preflopPercentile } from '../../src/engine/preflopStrength';
import { HandCategory, type Card, type PlayerAction } from '../../src/engine/types';
import { analyseHand } from '../../src/ai/handFeatures';

export type Bot = (game: GameState, seat: number, rng: () => number) => PlayerAction;

/** Deterministic PRNG (mulberry32), the same one the AI tests use. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
const act = (type: PlayerAction['type'], amount = 0): PlayerAction => ({ type, amount });

/** Wager level that adds `fraction` of the pot (after calling) on top of the current level. */
function betTo(game: GameState, seat: number, fraction: number): number {
  const legal = getLegalActions(game, seat);
  const level = game.players[seat].streetCommitted + legal.callAmount;
  const target = level + Math.round((totalPot(game) + legal.callAmount) * fraction);
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, target));
}

function raiseTimes(game: GameState, seat: number, times: number): number {
  const legal = getLegalActions(game, seat);
  return Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(game.currentBet * times)));
}

function aggress(game: GameState, seat: number, target: number): PlayerAction {
  const legal = getLegalActions(game, seat);
  if (!(legal.canBet || legal.canRaise)) return legal.canCheck ? act('check') : act('call');
  const amount = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, target));
  return amount >= legal.maxRaiseTo ? act('allin', legal.maxRaiseTo) : act('raise', amount);
}

const passive = (game: GameState, seat: number): PlayerAction =>
  getLegalActions(game, seat).canCheck ? act('check') : act('call');
const giveUp = (game: GameState, seat: number): PlayerAction =>
  getLegalActions(game, seat).canCheck ? act('check') : act('fold');

function preflopRaises(game: GameState): number {
  return game.history.filter((a) => a.street === 'preflop' && AGGRESSIVE.has(a.type)).length;
}

function readHand(game: GameState, seat: number) {
  const hole = game.players[seat].hole as [Card, Card];
  const f = analyseHand(hole, game.board);
  const top = f.category === HandCategory.Pair && (f.pairKind === 'top' || f.pairKind === 'over');
  const holeContributes =
    hole[0].rank === hole[1].rank ||
    hole.some((c) => game.board.some((b) => b.rank === c.rank)) ||
    f.category >= HandCategory.Straight;
  const monster =
    f.category >= HandCategory.TwoPair &&
    holeContributes &&
    (game.board.length < 5 ||
      evaluateHand([...hole, ...game.board]).score > evaluateHand(game.board).score);
  const anyPair = f.category >= HandCategory.Pair && f.pairKind !== 'under';
  const draw = game.board.length < 5 && (f.flushDraw || f.openEnded || f.comboDraw);
  const gutshot = game.board.length < 5 && f.straightDraw && !f.openEnded;
  const toCall = getLegalActions(game, seat).callAmount;
  return {
    monster,
    top,
    topPairPlus: monster || top,
    anyPair,
    draw,
    gutshot,
    air: !anyPair && !draw && !gutshot,
    toCall,
    /** Price of the call relative to the pot before it. */
    betFraction: toCall / Math.max(1, totalPot(game) - toCall),
  };
}

/** Pre-flop by fixed percentile thresholds of the playability order. */
interface PreflopChart {
  open: number;
  threeBet: number;
  call: number;
  callThreeBet: number;
  fourBet: number;
  openSizeBB: number;
}

function preflopByChart(game: GameState, seat: number, chart: PreflopChart): PlayerAction {
  const p = game.players[seat];
  const pct = preflopPercentile(p.hole[0], p.hole[1]);
  const raises = preflopRaises(game);
  const legal = getLegalActions(game, seat);
  if (raises === 0) {
    if (pct >= 1 - chart.open) return aggress(game, seat, Math.round(game.bigBlind * chart.openSizeBB));
    return legal.canCheck ? act('check') : act('fold');
  }
  if (raises === 1) {
    if (pct >= 1 - chart.threeBet) return aggress(game, seat, raiseTimes(game, seat, 3));
    if (pct >= 1 - chart.call) return act('call');
    return giveUp(game, seat);
  }
  if (raises === 2) {
    if (pct >= 1 - chart.fourBet) return aggress(game, seat, raiseTimes(game, seat, 2.3));
    if (pct >= 1 - chart.callThreeBet) return act('call');
    return giveUp(game, seat);
  }
  if (pct >= 0.985) return aggress(game, seat, legal.maxRaiseTo);
  if (pct >= 1 - chart.fourBet * 0.8) return act('call');
  return giveUp(game, seat);
}

export const BOTS: Record<string, Bot> = {
  /** Limps and calls wide, calls down any pair or draw, bets only strong hands. */
  station: (game, seat, rng) => {
    if (game.street === 'preflop') {
      const p = game.players[seat];
      const pct = preflopPercentile(p.hole[0], p.hole[1]);
      const raises = preflopRaises(game);
      const level = game.currentBet / game.bigBlind;
      if (pct >= 0.985) {
        return aggress(game, seat, raises === 0 ? game.bigBlind * 3 : raiseTimes(game, seat, 3));
      }
      if (raises === 0) return pct >= 0.4 ? passive(game, seat) : giveUp(game, seat);
      if (level <= 5) return pct >= 0.45 ? act('call') : giveUp(game, seat);
      if (level <= 14) return pct >= 0.78 ? act('call') : giveUp(game, seat);
      return pct >= 0.94 ? act('call') : giveUp(game, seat);
    }
    const h = readHand(game, seat);
    if (h.toCall === 0) {
      if (h.monster && rng() < 0.7) return aggress(game, seat, betTo(game, seat, 0.5));
      if (h.top && rng() < 0.4) return aggress(game, seat, betTo(game, seat, 0.5));
      return act('check');
    }
    if (h.monster && rng() < 0.25) return aggress(game, seat, raiseTimes(game, seat, 2.6));
    if (h.anyPair || h.draw || h.gutshot) return act('call');
    if (game.street === 'flop' && rng() < 0.35) return act('call');
    return act('fold');
  },

  /** Opens 55%, bets 80% when checked to, raises draws and some air. */
  maniac: (game, seat, rng) => {
    if (game.street === 'preflop') {
      return preflopByChart(game, seat, { open: 0.55, threeBet: 0.25, call: 0.5, callThreeBet: 0.28, fourBet: 0.1, openSizeBB: 3.5 });
    }
    const h = readHand(game, seat);
    if (h.toCall === 0) {
      return rng() < 0.8 ? aggress(game, seat, betTo(game, seat, 0.75)) : act('check');
    }
    if ((h.monster || h.draw) && rng() < 0.5) return aggress(game, seat, raiseTimes(game, seat, 3));
    if (h.air && rng() < 0.2) return aggress(game, seat, raiseTimes(game, seat, 3));
    if (h.anyPair || h.draw || h.gutshot) return act('call');
    return rng() < 0.4 ? act('call') : act('fold');
  },

  /** Plays 12% of hands, bets only top pair or better, folds everything else to a bet. */
  nit: (game, seat, rng) => {
    if (game.street === 'preflop') {
      return preflopByChart(game, seat, { open: 0.12, threeBet: 0.03, call: 0.1, callThreeBet: 0.03, fourBet: 0.02, openSizeBB: 3 });
    }
    const h = readHand(game, seat);
    if (h.toCall === 0) return h.topPairPlus ? aggress(game, seat, betTo(game, seat, 0.6)) : act('check');
    if (h.monster) return rng() < 0.5 ? aggress(game, seat, raiseTimes(game, seat, 2.8)) : act('call');
    if (h.topPairPlus) return act('call');
    if (h.draw && h.betFraction <= 0.34) return act('call');
    return act('fold');
  },

  /** C-bets 70% at half pot, then overbets 1.25 pot with monsters and most air, checks the middle. */
  overbettor: (game, seat, rng) => {
    if (game.street === 'preflop') {
      return preflopByChart(game, seat, { open: 0.22, threeBet: 0.05, call: 0.15, callThreeBet: 0.05, fourBet: 0.025, openSizeBB: 3 });
    }
    const h = readHand(game, seat);
    if (h.toCall === 0) {
      if (game.street === 'flop') return rng() < 0.7 ? aggress(game, seat, betTo(game, seat, 0.5)) : act('check');
      if (h.monster) return aggress(game, seat, betTo(game, seat, 1.25));
      if (h.air && rng() < 0.8) return aggress(game, seat, betTo(game, seat, 1.25));
      return act('check');
    }
    if (h.monster) return aggress(game, seat, raiseTimes(game, seat, 2.8));
    if (h.topPairPlus) return act('call');
    if ((h.anyPair || h.draw) && h.betFraction <= 0.55) return act('call');
    return act('fold');
  },

  /** Stabs a quarter pot at 90% of chances, but folds anything below top pair once raised. */
  prober: (game, seat, rng) => {
    if (game.street === 'preflop') {
      return preflopByChart(game, seat, { open: 0.3, threeBet: 0.04, call: 0.35, callThreeBet: 0.06, fourBet: 0.025, openSizeBB: 2.5 });
    }
    const h = readHand(game, seat);
    const alreadyBet = game.history.some(
      (a) => a.street === game.street && a.playerId === game.players[seat].id && (a.type === 'raise' || a.type === 'bet'),
    );
    if (h.toCall === 0) return rng() < 0.9 ? aggress(game, seat, betTo(game, seat, 0.25)) : act('check');
    if (alreadyBet) return h.topPairPlus ? act('call') : act('fold');
    if (h.anyPair || h.draw) return act('call');
    return act('fold');
  },

  /** Straightforward "ABC" poker: bets value and some draws, calls top pair, rarely bluffs. */
  abc: (game, seat, rng) => {
    if (game.street === 'preflop') {
      return preflopByChart(game, seat, { open: 0.2, threeBet: 0.04, call: 0.12, callThreeBet: 0.04, fourBet: 0.025, openSizeBB: 3 });
    }
    const h = readHand(game, seat);
    if (h.toCall === 0) {
      if (h.topPairPlus) return aggress(game, seat, betTo(game, seat, 0.66));
      if (h.draw && rng() < 0.4) return aggress(game, seat, betTo(game, seat, 0.66));
      return act('check');
    }
    if (h.monster) return rng() < 0.5 ? aggress(game, seat, raiseTimes(game, seat, 2.8)) : act('call');
    if (h.topPairPlus) return act('call');
    if (h.anyPair && game.street === 'flop' && h.betFraction <= 0.55) return act('call');
    if (h.draw && game.street !== 'river' && h.betFraction <= 0.75) return act('call');
    return act('fold');
  },
};
