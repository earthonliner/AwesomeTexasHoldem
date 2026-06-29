import type { GameState } from '../engine/gameTypes';
import type { Card } from '../engine/types';
import { estimateEquityVsRange, estimateRangeFraction, estimateBluffShare } from '../engine/monteCarlo';
import { countOuts, hitProbability, potOdds, callEV, evaluateHand, CATEGORY_LABEL } from '../engine';
import { getLegalActions, totalPot } from '../engine/game';
import { boardWetness } from '../ai/boardTexture';

export interface HeroAnalysis {
  equity: number;
  win: number;
  tie: number;
  outs: number;
  hitTurn: number;
  hitRiver: number;
  hitByRiver: number;
  potOdds: number;
  callAmount: number;
  callEV: number;
  raiseEVHint: number;
  madeHand: string | null;
  potBefore: number;
  /** Assumed opponent range tightness (fraction of strongest hands). */
  rangeFraction: number;
  /** Assumed share of the opponent's betting range that is a bluff. */
  bluffShare: number;
  iterations: number;
  liveOpponents: number;
}

/** Find the hero's seat index. */
function heroIndex(state: GameState): number {
  return state.players.findIndex((p) => p.isHero);
}

export interface FoldOutcome {
  /** The full 5-card board (real cards plus a runout if the hand ended early). */
  fullBoard: Card[];
  result: 'win' | 'tie' | 'lose';
  heroCategory: string;
  bestOppCategory: string;
  bestOppName: string;
  /** True if part of the board was a hypothetical runout (hand ended early). */
  hypothetical: boolean;
}

/**
 * After the hero folds, work out whether the folded hand *would* have won at
 * showdown. The board is completed with a plausible runout from the remaining
 * deck when the hand ended before the river, and the hero's hand is compared
 * against every other dealt-in player. Purely for post-hand learning.
 */
export function computeFoldOutcome(args: {
  heroHole: Card[];
  board: Card[];
  deck: Card[];
  opponents: { name: string; hole: Card[] }[];
}): FoldOutcome | null {
  const { heroHole, board, deck, opponents } = args;
  if (heroHole.length < 2) return null;
  const liveOpps = opponents.filter((o) => o.hole.length === 2);
  if (liveOpps.length === 0) return null;

  const need = 5 - board.length;
  if (need > deck.length) return null;
  const fullBoard = [...board, ...deck.slice(0, need)];
  const hypothetical = need > 0;

  const heroEval = evaluateHand([...heroHole, ...fullBoard]);
  let bestScore = -Infinity;
  let bestName = '';
  let bestLabel = '';
  for (const o of liveOpps) {
    const e = evaluateHand([...o.hole, ...fullBoard]);
    if (e.score > bestScore) {
      bestScore = e.score;
      bestName = o.name;
      bestLabel = CATEGORY_LABEL[e.category];
    }
  }

  const result: FoldOutcome['result'] =
    heroEval.score > bestScore ? 'win' : heroEval.score === bestScore ? 'tie' : 'lose';

  return {
    fullBoard,
    result,
    heroCategory: CATEGORY_LABEL[heroEval.category],
    bestOppCategory: bestLabel,
    bestOppName: bestName,
    hypothetical,
  };
}

/**
 * Compute the objective math panel for the hero's current spot. Runs a quick
 * Monte-Carlo so it is safe to call on each hero turn.
 */
export function computeHeroAnalysis(state: GameState, iterations = 1200): HeroAnalysis | null {
  const hi = heroIndex(state);
  if (hi < 0) return null;
  const hero = state.players[hi];
  if (hero.hole.length < 2) return null;

  const liveOpponents = state.players.filter((p) => !p.folded && !p.sittingOut && !p.isHero).length;
  const board = state.board;

  const legal = state.toAct === hi ? getLegalActions(state, hi) : null;
  const callAmount = legal?.callAmount ?? 0;
  const potBefore = totalPot(state);

  // Model opponents as a realistic range (stronger than random) instead of two
  // random cards — this is what makes turn/river call equity trustworthy.
  const facingBet = callAmount > 0;
  const rangeFraction = estimateRangeFraction({
    street: state.street,
    facingBet,
    toCall: callAmount,
    pot: potBefore,
  });
  // Model a polarized betting range (value + bluffs) so bluff-catchers get
  // realistic equity instead of ~0% against a value-only range.
  const bluffShare = estimateBluffShare({
    facingBet,
    liveOpponents: Math.max(1, liveOpponents),
    wetness: boardWetness(board),
  });

  const eq = estimateEquityVsRange({
    heroCards: hero.hole as [Card, Card],
    board,
    opponents: Math.max(1, liveOpponents),
    iterations,
    rangeFraction,
    bluffShare,
  });

  let outs = 0;
  let hitTurn = 0;
  let hitRiver = 0;
  let hitByRiver = 0;
  if (board.length === 3 || board.length === 4) {
    const o = countOuts(hero.hole, board);
    outs = o.outs;
    if (board.length === 3) {
      hitTurn = hitProbability(outs, 1);
      hitByRiver = hitProbability(outs, 2);
      hitRiver = hitTurn;
    } else {
      hitRiver = hitProbability(outs, 1);
      hitByRiver = hitRiver;
    }
  }

  const po = potOdds(potBefore, callAmount);
  const evCall = callEV(eq.equity, potBefore, callAmount);

  // Rough raise EV hint: fold equity * pot + called equity portion. Coarse signal.
  const raiseEVHint = eq.equity * potBefore * 1.3 - (1 - eq.equity) * Math.max(callAmount, potBefore * 0.5);

  const madeHand =
    board.length >= 3 ? CATEGORY_LABEL[evaluateHand([...hero.hole, ...board]).category] : null;

  return {
    equity: eq.equity,
    win: eq.win,
    tie: eq.tie,
    outs,
    hitTurn,
    hitRiver,
    hitByRiver,
    potOdds: po,
    callAmount,
    callEV: evCall,
    raiseEVHint,
    madeHand,
    potBefore,
    rangeFraction,
    bluffShare,
    iterations: eq.iterations,
    liveOpponents: Math.max(1, liveOpponents),
  };
}
