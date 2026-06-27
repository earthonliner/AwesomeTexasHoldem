import type { GameState } from '../engine/gameTypes';
import type { Card } from '../engine/types';
import { estimateEquityVsRange, estimateRangeFraction } from '../engine/monteCarlo';
import { countOuts, hitProbability, potOdds, callEV, evaluateHand, CATEGORY_LABEL } from '../engine';
import { getLegalActions, totalPot } from '../engine/game';

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
  iterations: number;
  liveOpponents: number;
}

/** Find the hero's seat index. */
function heroIndex(state: GameState): number {
  return state.players.findIndex((p) => p.isHero);
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
  const rangeFraction = estimateRangeFraction({
    street: state.street,
    facingBet: callAmount > 0,
    toCall: callAmount,
    pot: potBefore,
  });

  const eq = estimateEquityVsRange({
    heroCards: hero.hole as [Card, Card],
    board,
    opponents: Math.max(1, liveOpponents),
    iterations,
    rangeFraction,
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
    iterations: eq.iterations,
    liveOpponents: Math.max(1, liveOpponents),
  };
}
