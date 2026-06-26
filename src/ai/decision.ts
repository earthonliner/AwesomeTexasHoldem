import type { Rng } from '../engine/deck';
import { defaultRng } from '../engine/deck';
import type { Difficulty } from '../engine/gameTypes';
import { estimateEquity } from '../engine/monteCarlo';
import { potOdds } from '../engine/odds';
import type { Personality, DecisionContext, AIDecision, HeroProfile } from './types';
import { dynamicBluffFrequency } from './dynamicBluff';

export interface DecideOptions {
  personality: Personality;
  difficulty: Difficulty;
  ctx: DecisionContext;
  rng?: Rng;
  /** Hero profile, only consulted by HARD opponents to exploit. */
  heroProfile?: HeroProfile;
  /** Monte-Carlo iterations; kept low for snappy play, higher in tests. */
  iterations?: number;
}

function chooseRaiseTarget(
  ctx: DecisionContext,
  sizeFraction: number,
  rng: Rng,
): { amount: number; allIn: boolean } {
  const currentLevel = ctx.streetCommitted + ctx.toCall;
  const potAfterCall = ctx.potBefore + ctx.toCall;
  const jitter = 0.9 + rng() * 0.2;
  const raiseBy = Math.max(ctx.bigBlind, Math.round(potAfterCall * sizeFraction * jitter));
  let target = currentLevel + raiseBy;

  target = Math.max(target, ctx.minRaiseTo);
  if (target >= ctx.maxRaiseTo * 0.85) {
    return { amount: ctx.maxRaiseTo, allIn: true };
  }
  target = Math.min(target, ctx.maxRaiseTo);
  return { amount: target, allIn: target >= ctx.maxRaiseTo };
}

function thinkTime(rng: Rng, tough: boolean): number {
  const base = 350 + rng() * 700;
  return Math.round(base + (tough ? rng() * 600 : 0));
}

/**
 * Core AI decision. Combines a Monte-Carlo equity estimate with the personality
 * vector and situational modifiers, producing an action, sizing and a natural
 * thinking delay.
 */
export function decide(opts: DecideOptions): AIDecision {
  const { personality: p, difficulty, ctx, rng = defaultRng, heroProfile } = opts;
  const iterations = opts.iterations ?? (ctx.street === 'preflop' ? 200 : 300);

  const oppMode = difficulty === 'easy' ? 'random' : 'range';
  const equity = estimateEquity({
    heroCards: ctx.hole,
    board: ctx.board,
    opponents: Math.max(1, ctx.liveOpponents),
    iterations,
    rng,
    mode: oppMode,
  }).equity;

  const breakeven = 1 / (ctx.liveOpponents + 1);
  const required = ctx.toCall > 0 ? potOdds(ctx.potBefore, ctx.toCall) : 0;

  // Personality-shaped continue/value thresholds.
  const positionLoosen = p.positionAwareness * (ctx.positionFactor - 0.5) * 0.18;
  const loosenByDifficulty = difficulty === 'easy' ? 0 : positionLoosen;

  let valueRaise = breakeven * 1.55 - loosenByDifficulty;
  let decent = breakeven * 1.12 - loosenByDifficulty;

  // Preflop: gate by vpip/pfr so loose players see more flops.
  if (ctx.street === 'preflop') {
    const playThreshold = breakeven * (0.85 + (1 - p.vpip) * 1.1) - loosenByDifficulty;
    decent = Math.max(decent, playThreshold);
    valueRaise = Math.max(valueRaise, breakeven * (1.1 + (1 - p.pfr) * 0.6));
  }

  // HARD exploit: adjust against the observed hero tendencies.
  let bluffMultiplier = 1;
  let stealUrge = 0;
  if (difficulty === 'hard' && heroProfile && heroProfile.hands > 15) {
    if (heroProfile.foldToSteal > 0.6) stealUrge = (heroProfile.foldToSteal - 0.6) * 0.8;
    // Hero folds a lot -> bluff more; hero calls down light -> bluff less, value more.
    if (heroProfile.wentToShowdown > 0.4) bluffMultiplier *= 0.6;
    if (heroProfile.foldToSteal > 0.55) bluffMultiplier *= 1.3;
    // Hero is very aggressive -> widen call-downs (trap), lower our bluffs.
    if (heroProfile.aggression > 0.6) bluffMultiplier *= 0.8;
  }

  const isStrong = equity >= valueRaise;
  const isDecent = equity >= decent;

  let bluffFreq = dynamicBluffFrequency(p, ctx) * bluffMultiplier;
  if (difficulty === 'easy') bluffFreq *= 0.4;
  bluffFreq = Math.min(0.85, bluffFreq + stealUrge);
  const wantBluff = ctx.street !== 'showdown' && !isStrong && rng() < bluffFreq;

  const reasonBits: string[] = [
    `eq=${equity.toFixed(2)}`,
    `be=${breakeven.toFixed(2)}`,
    `req=${required.toFixed(2)}`,
    `bluff=${bluffFreq.toFixed(2)}`,
  ];

  // ---- No bet to call: we may check or open ----
  if (ctx.canCheck) {
    if (isStrong || (isDecent && rng() < p.aggression)) {
      const size = 0.5 + p.aggression * 0.4;
      const { amount, allIn } = chooseRaiseTarget(ctx, size, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reasonBits, 'value-bet']);
    }
    if (wantBluff) {
      const size = 0.55 + p.aggression * 0.35;
      const { amount, allIn } = chooseRaiseTarget(ctx, size, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reasonBits, 'bluff-bet']);
    }
    return mk('check', 0, rng, false, [...reasonBits, 'check']);
  }

  // ---- Facing a bet ----
  if (isStrong) {
    if (rng() < p.aggression * 0.8) {
      const size = 0.55 + p.aggression * 0.4;
      const { amount, allIn } = chooseRaiseTarget(ctx, size, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reasonBits, 'value-raise']);
    }
    return mk('call', 0, rng, false, [...reasonBits, 'strong-call']);
  }

  // Call-down lowers the equity we need to continue (sticky players).
  const callAdjust = required * (1 - p.callDown * 0.35);
  if (equity >= callAdjust) {
    if (isDecent && rng() < p.aggression * 0.45) {
      const size = 0.5 + p.aggression * 0.35;
      const { amount, allIn } = chooseRaiseTarget(ctx, size, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reasonBits, 'semi-raise']);
    }
    return mk('call', 0, rng, false, [...reasonBits, 'odds-call']);
  }

  // Weak: occasionally bluff-raise if it's cheap, otherwise fold.
  if (wantBluff && ctx.toCall <= ctx.potBefore * 0.6) {
    const size = 0.6 + p.aggression * 0.3;
    const { amount, allIn } = chooseRaiseTarget(ctx, size, rng);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reasonBits, 'bluff-raise']);
  }

  return mk('fold', 0, rng, false, [...reasonBits, 'fold']);
}

function mk(
  action: AIDecision['action'],
  amount: number,
  rng: Rng,
  isBluff: boolean,
  reason: string[],
): AIDecision {
  const tough = action === 'fold' || action === 'call';
  return { action, amount, isBluff, thinkMs: thinkTime(rng, tough), reason: reason.join(' ') };
}
