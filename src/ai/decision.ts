import type { Rng } from '../engine/deck';
import { defaultRng } from '../engine/deck';
import type { Difficulty } from '../engine/gameTypes';
import { HandCategory } from '../engine/types';
import {
  estimateEquity,
  estimateEquityVsRange,
  estimateRangeFraction,
  estimateBluffShare,
} from '../engine/monteCarlo';
import type { Personality, DecisionContext, AIDecision, HeroProfile } from './types';
import { dynamicBluffFrequency } from './dynamicBluff';
import { boardWetness } from './boardTexture';
import {
  isSuitedAce,
  isSuitedConnector,
  preflopPercentile,
  startingHandClass,
} from './preflop';
import { analyseHand, type HandFeatures } from './handFeatures';

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

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * True when the stack is genuinely committed relative to the pot (SPR ≤ ~1).
 * Only these spots justify an all-in in a cash game; anything deeper should be
 * played with normal fraction-of-pot sizing that preserves the stack.
 */
function isShortStack(ctx: DecisionContext): boolean {
  const call = Math.min(ctx.toCall, ctx.stack);
  const potAfterCall = ctx.potBefore + call;
  const effectiveRemaining = Math.max(0, Math.min(ctx.stack, ctx.effectiveStack ?? ctx.stack) - call);
  return effectiveRemaining <= potAfterCall * 1.1;
}

/**
 * Size a bet/raise with cash-game discipline.
 *
 * - Opening bet (nothing to call): a fraction of the pot (1/3..~pot).
 * - Raise (facing a bet): sized RELATIVE TO THE BET — raise to ~2.2–3.2× the
 *   current bet, additionally capped by a pot-fraction raise. This is how cash
 *   players actually size (open 2.5–3.5bb, 3-bet ~3× the open, 4-bet ~2.3×…);
 *   the previous "fraction of the (already inflated) pot" rule compounded each
 *   round of a raise war and produced absurd 50–100bb jumps.
 * - All-in only at a genuine commit spot (`allowAllIn`, SPR ≤ 1) or when forced
 *   by min-raise rules; deep stacks always keep chips behind.
 */
function sizeRaise(
  ctx: DecisionContext,
  fraction: number,
  rng: Rng,
  allowAllIn: boolean,
  capTarget = Infinity,
  xBetBonus = 0,
  xBetBase = 2.35,
): {
  amount: number;
  allIn: boolean;
  heroRisk: number;
  callerContribution: number;
} {
  const currentLevel = ctx.streetCommitted + ctx.toCall;
  const potAfterCall = ctx.potBefore + ctx.toCall;
  const jitter = 0.9 + rng() * 0.2;

  let target: number;
  if (ctx.toCall > 0 && currentLevel > 0) {
    // Facing a bet: raise to a standard multiple of the bet, never beyond a
    // pot-fraction raise on top of a call. Kept at the small end of real cash
    // sizing (open ~2-2.7bb, 3-bet ~2.5x open; squeezes add ~1x per caller).
    const xBet = currentLevel * (xBetBase + rng() * 0.4 + xBetBonus);
    const potCap = currentLevel + potAfterCall * Math.max(fraction, 0.5) * jitter;
    target = Math.round(Math.min(xBet, potCap));
  } else {
    // Opening bet: fraction of the pot.
    const betBy = Math.max(ctx.bigBlind, Math.round(potAfterCall * fraction * jitter));
    target = currentLevel + betBy;
  }
  // Stake budget: never escalate the hand beyond what the hand strength is worth.
  target = Math.min(target, Math.floor(capTarget));
  target = Math.max(target, ctx.minRaiseTo);

  if (target >= ctx.maxRaiseTo) {
    target = ctx.maxRaiseTo;
  } else if (allowAllIn && target >= ctx.maxRaiseTo * 0.9) {
    // Already nearly all-in at a commit spot: don't leave dust behind.
    target = ctx.maxRaiseTo;
  } else {
    target = Math.min(target, ctx.maxRaiseTo);
  }

  const heroRisk = Math.max(0, target - ctx.streetCommitted);
  const callerContribution = Math.max(0, target - currentLevel);
  return {
    amount: target,
    allIn: target >= ctx.maxRaiseTo,
    heroRisk,
    callerContribution,
  };
}

/**
 * Cash-game stake budgeting: how many chips a sensible player is willing to
 * invest in ONE hand, as a function of hand strength. In a friendly 6-max cash
 * game a hand's investment rarely exceeds ~50 big blinds — only near-nut hands
 * stack off. Exceeding the budget downgrades a raise to a call/fold; calls
 * themselves stay pot-odds-driven (budget limits escalation, not defense).
 */
function investBudget(eq: number, bigBlind: number): number {
  if (eq >= 0.85) return Infinity; // near-nuts: stacking off is fine
  if (eq >= 0.7) return bigBlind * 50;
  if (eq >= 0.55) return bigBlind * 30;
  return bigBlind * 14; // air, weak pairs, draws: keep the pot small
}

/** Same idea pre-flop, driven by the starting-hand percentile. */
function preflopBudget(pct: number, bigBlind: number): number {
  if (pct >= 0.985) return Infinity; // QQ+/AK territory
  if (pct >= 0.94) return bigBlind * 25;
  if (pct >= 0.85) return bigBlind * 12;
  return bigBlind * 6;
}

/**
 * Highest raise target that keeps this hand's total investment within budget.
 * Returns Infinity when uncapped.
 */
function budgetCapTarget(ctx: DecisionContext, budget: number): number {
  if (!Number.isFinite(budget)) return Infinity;
  const investedBeforeStreet = Math.max(0, ctx.totalCommitted - ctx.streetCommitted);
  return Math.max(0, budget - investedBeforeStreet);
}

/** Whether a legal raise is possible without blowing the budget. */
function canRaiseWithinBudget(ctx: DecisionContext, capTarget: number): boolean {
  return capTarget >= ctx.minRaiseTo;
}

/**
 * A single bet-sizing distribution used for BOTH value bets and bluffs, so a
 * bluff is not betrayed by an unusual size. Real cash c-bets are mostly
 * third-to-two-thirds pot (a touch larger on wet boards); overbets are rare.
 */
function geometricBetFraction(ctx: DecisionContext): number {
  const effective = Math.max(0, Math.min(ctx.stack, ctx.effectiveStack ?? ctx.stack));
  const streets = ctx.street === 'flop' ? 3 : ctx.street === 'turn' ? 2 : 1;
  if (ctx.potBefore <= 0 || effective <= 0) return 0.5;
  return (Math.pow(1 + (2 * effective) / ctx.potBefore, 1 / streets) - 1) / 2;
}

/**
 * Board/pot/SPR-aware sizing buckets. Value and bluffs still call this same
 * function; the `polar` flag describes the range, not the hidden hand.
 */
function pickBetSize(
  p: Personality,
  ctx: DecisionContext,
  features: HandFeatures,
  polar: boolean,
  rng: Rng,
): number {
  const wet = boardWetness(ctx.board);
  const paired = new Set(ctx.board.map((c) => c.rank)).size < ctx.board.length;
  let fraction: number;

  if (ctx.street === 'flop') {
    fraction = paired || wet < 0.22 ? 0.3 : 0.48 + wet * 0.28;
    if (ctx.preflopPotType === 'threeBet' || ctx.preflopPotType === 'fourBetPlus') {
      fraction -= 0.08; // range advantage supports a small c-bet in bloated pots
    }
  } else if (ctx.street === 'turn') {
    fraction = 0.52 + wet * 0.28;
    if (polar) fraction += 0.1;
  } else {
    fraction = polar ? 0.72 + features.blockerScore * 0.18 : 0.34;
  }

  if (ctx.liveOpponents > 1) fraction += 0.08;
  const geometric = geometricBetFraction(ctx);
  const spr = ctx.potBefore > 0 ? (ctx.effectiveStack ?? ctx.stack) / ctx.potBefore : 10;
  if (spr <= 3) fraction = Math.max(fraction, Math.min(1, geometric));
  fraction += (p.aggression - 0.6) * 0.08;

  // Overbets belong to polar turn/river ranges with nut/blocker interaction,
  // never to an arbitrary 4% of all hands and boards.
  if (
    polar &&
    (ctx.street === 'turn' || ctx.street === 'river') &&
    (features.category >= HandCategory.Flush || features.blockerScore >= 0.45) &&
    rng() < 0.18
  ) {
    fraction = Math.max(fraction, 1.05 + rng() * 0.2);
  }

  return clamp(fraction + (rng() - 0.5) * 0.08, 0.25, 1.25);
}

function thinkTime(rng: Rng, tough: boolean): number {
  const base = 350 + rng() * 700;
  return Math.round(base + (tough ? rng() * 700 : 0));
}

function mk(
  action: AIDecision['action'],
  amount: number,
  rng: Rng,
  isBluff: boolean,
  reason: string[],
  tough = false,
): AIDecision {
  const slow = tough || action === 'fold' || action === 'call';
  return { action, amount, isBluff, thinkMs: thinkTime(rng, slow), reason: reason.join(' ') };
}

interface Exploit {
  bluffMult: number;
  stealBonus: number;
  /** Widen value / narrow our own bluffs when the hero calls down light. */
  valueLean: number;
  /** Prefer trapping (call, let them keep barreling) vs an aggressive hero. */
  trapMore: boolean;
  /** Multipliers on the assumed bluff share of the HERO's bets, calibrated from
   * showdown evidence (river honesty), optionally split by bet size. */
  bluffReadAll: number;
  bluffReadBig: number;
  bluffReadSmall: number;
  /** >1 means the observed player's pre-flop range is wider than baseline. */
  rangeMult: number;
  /** Estimated propensity to release marginal hands under pressure. */
  foldPressure: number;
}

/** Blend an exploit multiplier toward neutral (1) by sample confidence. */
const blend = (raw: number, weight: number) => 1 + (raw - 1) * weight;

/**
 * Exploitative adjustments against the observed human style. Medium and hard
 * are equally sharp readers (medium is the "realistic cash game" variant, hard
 * the more aggressive one); easy doesn't adjust at all. All reads are weighted
 * by sample size, so early noise fades toward neutral instead of hard cutoffs.
 */
function computeExploit(difficulty: Difficulty, ctx: DecisionContext, profile?: HeroProfile): Exploit {
  const base: Exploit = {
    bluffMult: 1,
    stealBonus: 0,
    valueLean: 0,
    trapMore: false,
    bluffReadAll: 1,
    bluffReadBig: 1,
    bluffReadSmall: 1,
    rangeMult: 1,
    foldPressure: 1,
  };
  if (difficulty !== 'hard' || !profile) return base;
  const c = profile.counters;
  const confidence = (samples: number, target: number) => clamp(samples / target, 0, 1);
  const weight = confidence(profile.hands, 36);
  const stealWeight = weight * confidence(c.stealFaced, 8);
  const cbetWeight = weight * confidence(c.cbetFaced, 10);
  const actionWeight = weight * confidence(c.aggressiveActions + c.passiveActions, 35);

  if (profile.foldToSteal > 0.6 && ctx.positionFactor > 0.55) {
    base.stealBonus = (profile.foldToSteal - 0.6) * 0.6 * stealWeight;
  }
  if (profile.foldToSteal > 0.55) base.bluffMult *= blend(1.3, stealWeight);
  if (profile.wentToShowdown > 0.45) base.bluffMult *= blend(0.6, weight); // sticky -> bluff less
  if (profile.aggression > 0.6) {
    base.bluffMult *= blend(0.8, actionWeight);
    base.valueLean += 0.05 * actionWeight; // call down lighter vs maniacs
    base.trapMore = actionWeight > 0.3;
  }

  // Hero folds to c-bets a lot -> barrel/bluff more (and vice versa).
  base.bluffMult *= blend(1 + (profile.foldToCbet - 0.5) * 0.9, cbetWeight);
  base.foldPressure = blend(
    1 + (profile.foldToCbet - 0.5) * 0.7 + (profile.foldToSteal - 0.5) * 0.4,
    Math.max(cbetWeight, stealWeight),
  );
  const observedRange = clamp(
    (profile.vpip / 0.28) * 0.45 + (profile.pfr / 0.18) * 0.55,
    0.65,
    1.65,
  );
  base.rangeMult = blend(observedRange, weight);

  // River honesty: calibrate how much of the hero's betting range we assume is
  // bluffs from actual showdown evidence, instead of a fixed formula.
  const readScale = (weak: number, shown: number): number =>
    shown >= 4 ? clamp(weak / shown / 0.33, 0.35, 1.8) : NaN;
  const all = readScale(c.riverBetsWeak, c.riverBetsShown);
  if (!Number.isNaN(all)) base.bluffReadAll = blend(all, weight);
  const big = readScale(c.riverBigWeak, c.riverBigShown);
  base.bluffReadBig = Number.isNaN(big) ? base.bluffReadAll : blend(big, weight);
  const small = readScale(c.riverSmallWeak, c.riverSmallShown);
  base.bluffReadSmall = Number.isNaN(small) ? base.bluffReadAll : blend(small, weight);

  return base;
}

export function decide(opts: DecideOptions): AIDecision {
  const { personality: p, difficulty, ctx, rng = defaultRng, heroProfile } = opts;
  const exploit = computeExploit(difficulty, ctx, heroProfile);
  return ctx.street === 'preflop'
    ? difficulty === 'easy'
      ? decidePreflopLegacy(p, difficulty, ctx, rng, exploit)
      : decidePreflop(p, difficulty, ctx, rng, exploit)
    : difficulty === 'easy'
      ? decidePostflopLegacy(p, difficulty, ctx, rng, exploit, opts.iterations)
      : decidePostflop(p, difficulty, ctx, rng, exploit, opts.iterations);
}

/**
 * Skilled pre-flop strategy: explicit unopened/limped/raised/3-bet/4-bet
 * states, position ranges, continuous size response and equity-based stack-off
 * decisions. This avoids accidental open limps and VPIP-based 100bb calls.
 */
function decidePreflop(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
): AIDecision {
  const { toCall, potBefore, canCheck, bigBlind } = ctx;
  const pct = preflopPercentile(ctx.hole[0], ctx.hole[1]);
  const hand = startingHandClass(ctx.hole[0], ctx.hole[1]);
  const position = inferredPosition(ctx);
  const inferredLevel = (ctx.currentBet ?? ctx.streetCommitted + toCall) / bigBlind;
  const inferredPotType =
    inferredLevel <= 1.5
      ? 'unopened'
      : inferredLevel <= 4.5
        ? 'singleRaised'
        : inferredLevel <= 12
          ? 'threeBet'
          : 'fourBetPlus';
  const potType =
    ctx.preflopPotType ??
    ((ctx.limpers ?? 0) > 0 && !ctx.preflopRaised
      ? 'limped'
      : ctx.preflopRaised === false
        ? inferredPotType === 'unopened'
          ? 'unopened'
          : inferredPotType
        : ctx.preflopRaised
          ? inferredPotType === 'unopened'
            ? 'singleRaised'
            : inferredPotType
          : inferredPotType);
  const raises =
    ctx.preflopRaiseCount ??
    (potType === 'fourBetPlus' ? 3 : potType === 'threeBet' ? 2 : potType === 'singleRaised' ? 1 : 0);
  const limpers = ctx.limpers ?? 0;
  const callers = ctx.callersAfterRaise ?? 0;
  const currentLevel = ctx.currentBet ?? ctx.streetCommitted + toCall;
  const wagerBB = currentLevel / bigBlind;
  const mayRaise = ctx.canRaise !== false && ctx.maxRaiseTo > currentLevel;
  const style = clamp(p.vpip / 0.27, 0.72, 1.4);
  const strength = pct + (rng() - 0.5) * 0.025;
  const reason = [
    `hand=${hand}`,
    `pct=${pct.toFixed(2)}`,
    `pot=${potType}`,
    `pos=${position}`,
  ];

  // Strong regulars open raise-or-fold. A deliberate limp mix is reserved for
  // the small blind, where completing is strategically normal.
  if (potType === 'unopened') {
    if (canCheck && position === 'bb') {
      return mk('check', 0, rng, false, [...reason, 'pf-option']);
    }
    const openRange = clamp(
      openingRange(position, ctx.tableSize ?? 6) * style + exploit.stealBonus,
      0.08,
      0.82,
    );
    if (strength < 1 - openRange) {
      return mk('fold', 0, rng, false, [...reason, `rfi=${openRange.toFixed(2)}`]);
    }
    if (!mayRaise) return mk('call', 0, rng, false, [...reason, 'pf-complete']);

    const sbLimpMix =
      position === 'sb' && !isPremium(hand) && rng() < 0.28 * (1 - p.aggression * 0.35);
    if (sbLimpMix) return mk('call', 0, rng, false, [...reason, 'pf-sb-limp']);

    const { amount, allIn } = sizeRaise(ctx, 0.9, rng, false, Infinity, 0, 2.55);
    return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-rfi']);
  }

  // Limped live pots: isolate with a live-sized raise. Over-limp only hands
  // whose pair/suited structure can realise multiway implied odds.
  if (potType === 'limped' || (raises === 0 && limpers > 0)) {
    const baseOpen = openingRange(position, ctx.tableSize ?? 6) * style;
    const isoRange = clamp(baseOpen + 0.1 + limpers * 0.018, 0.16, 0.58);
    const impliedHand =
      ctx.hole[0].rank === ctx.hole[1].rank ||
      isSuitedAce(ctx.hole[0], ctx.hole[1]) ||
      isSuitedConnector(ctx.hole[0], ctx.hole[1], 2);
    if (strength >= 1 - isoRange && mayRaise && rng() < 0.72 + p.aggression * 0.22) {
      const oop = position === 'sb' || position === 'bb';
      const { amount, allIn } = sizeRaise(
        ctx,
        1,
        rng,
        false,
        Infinity,
        limpers * 0.7 + (oop ? 0.45 : 0),
        3.05,
      );
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-iso']);
    }
    if (!canCheck && impliedHand && strength >= 1 - clamp(baseOpen + 0.18, 0, 0.65)) {
      return mk('call', 0, rng, false, [...reason, 'pf-overlimp']);
    }
    return mk(canCheck ? 'check' : 'fold', 0, rng, false, [...reason, 'pf-limp-fold']);
  }

  // Large raises/all-ins are equity-vs-range decisions, not VPIP cutoffs.
  const effective = Math.max(1, Math.min(ctx.stack, ctx.effectiveStack ?? ctx.stack));
  const committedCall =
    toCall >= effective * 0.52 || currentLevel >= ctx.maxRaiseTo;
  if (committedCall) {
    let jamRange =
      wagerBB >= 55 ? 0.045 : wagerBB >= 30 ? 0.07 : wagerBB >= 18 ? 0.11 : 0.17;
    if (potType === 'fourBetPlus') jamRange *= 0.72;
    if (ctx.aggressorIsHero) jamRange *= exploit.rangeMult;
    jamRange = clamp(jamRange, 0.025, 0.3);
    const eq = estimateEquityVsRange({
      heroCards: ctx.hole,
      opponents: Math.max(1, Math.min(ctx.liveOpponents, callers + 1)),
      iterations: difficulty === 'hard' ? 850 : 500,
      rng,
      rangeFraction: jamRange,
      preflopRangeFraction: 1,
    }).equity;
    const odds = toCall / Math.max(1, potBefore + toCall);
    reason.push(
      `jamEq=${eq.toFixed(2)}`,
      `odds=${odds.toFixed(2)}`,
      `villR=${jamRange.toFixed(2)}`,
    );
    if (eq + (ctx.aggressorIsHero ? exploit.valueLean * 0.3 : 0) >= odds + 0.012) {
      return mk('call', 0, rng, false, [...reason, 'pf-jam-call'], true);
    }
    return mk('fold', 0, rng, false, [...reason, 'pf-jam-fold'], true);
  }

  if (potType === 'singleRaised' || raises === 1) {
    const inPosition = ctx.inPositionVsAggressor ?? ctx.positionFactor >= 0.65;
    let defendRange =
      position === 'bb' ? 0.42 : position === 'sb' ? 0.23 : inPosition ? 0.24 : 0.17;
    defendRange *= Math.exp(-0.2 * Math.max(0, wagerBB - 2.5));
    if ((ctx.aggressorPositionFactor ?? 0.5) >= 0.72) defendRange *= 1.18;
    if ((ctx.aggressorPositionFactor ?? 0.5) <= 0.42) defendRange *= 0.78;
    defendRange *= style;
    defendRange *= ctx.aggressorIsHero ? Math.sqrt(exploit.rangeMult) : 1;
    defendRange += Math.min(0.08, callers * 0.035);
    defendRange = clamp(defendRange, 0.055, 0.56);

    if (strength < 1 - defendRange) {
      return mk('fold', 0, rng, false, [...reason, `def=${defendRange.toFixed(2)}`]);
    }

    const value3Range = (ctx.aggressorPositionFactor ?? 0.5) >= 0.72 ? 0.085 : 0.055;
    const value3 = strength >= 1 - value3Range;
    const bluff3 =
      isThreeBetBluff(ctx) &&
      strength >= 1 - Math.min(defendRange, 0.2) &&
      rng() < p.bluff * (inPosition ? 0.55 : 0.38) * exploit.foldPressure;
    if (mayRaise && (value3 || bluff3)) {
      const xBase = inPosition ? 2.9 : 3.65;
      const { amount, allIn } = sizeRaise(
        ctx,
        1,
        rng,
        false,
        Infinity,
        callers * 0.65,
        xBase,
      );
      return mk(
        allIn ? 'allin' : 'raise',
        amount,
        rng,
        bluff3,
        [...reason, callers > 0 ? 'pf-squeeze' : bluff3 ? 'pf-light-3bet' : 'pf-value-3bet'],
        true,
      );
    }
    return mk('call', 0, rng, false, [...reason, 'pf-defend-call'], true);
  }

  if (potType === 'threeBet' || raises === 2) {
    const inPosition = ctx.inPositionVsAggressor ?? ctx.positionFactor >= 0.65;
    const sizePenalty = clamp(1.15 - Math.max(0, wagerBB - 8) * 0.035, 0.65, 1.1);
    const continueRange = clamp(
      (inPosition ? 0.13 : 0.105) * sizePenalty * style,
      0.055,
      0.18,
    );
    const bluff4 =
      mayRaise &&
      isFourBetBluff(ctx) &&
      rng() < p.bluff * 0.3 * exploit.foldPressure;
    if (strength < 1 - continueRange && !bluff4) {
      return mk('fold', 0, rng, false, [...reason, 'pf-fold-vs-3bet']);
    }

    const value4 = strength >= 0.968;
    if (mayRaise && (value4 || bluff4)) {
      const { amount, allIn } = sizeRaise(
        ctx,
        0.8,
        rng,
        isShortStack(ctx),
        Infinity,
        0,
        2.15,
      );
      return mk(
        allIn ? 'allin' : 'raise',
        amount,
        rng,
        bluff4,
        [...reason, bluff4 ? 'pf-4bet-bluff' : 'pf-value-4bet'],
        true,
      );
    }
    return mk('call', 0, rng, false, [...reason, 'pf-call-3bet'], true);
  }

  const continueRange = clamp(
    0.05 * (ctx.aggressorIsHero ? exploit.rangeMult : 1),
    0.035,
    0.085,
  );
  if (strength < 1 - continueRange) {
    return mk('fold', 0, rng, false, [...reason, 'pf-fold-vs-4bet']);
  }
  if (mayRaise && strength >= 0.986 && rng() < 0.72) {
    const { amount, allIn } = sizeRaise(ctx, 0.8, rng, true, Infinity, 0, 2.05);
    return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-fivebet-value'], true);
  }
  return mk('call', 0, rng, false, [...reason, 'pf-call-4bet'], true);
}

function inferredPosition(ctx: DecisionContext): NonNullable<DecisionContext['position']> {
  if (ctx.position) return ctx.position;
  if (ctx.streetCommitted >= ctx.bigBlind) return 'bb';
  if (ctx.streetCommitted > 0) return 'sb';
  if (ctx.positionFactor >= 0.9) return 'btn';
  if (ctx.positionFactor >= 0.72) return 'co';
  if (ctx.positionFactor >= 0.55) return 'hj';
  if (ctx.positionFactor <= 0.35) return 'early';
  return 'middle';
}

function openingRange(
  position: NonNullable<DecisionContext['position']>,
  tableSize: number,
): number {
  switch (position) {
    case 'early':
      return tableSize >= 8 ? 0.145 : 0.19;
    case 'middle':
      return tableSize >= 8 ? 0.19 : 0.22;
    case 'hj':
      return 0.255;
    case 'co':
      return 0.33;
    case 'btn':
      return tableSize <= 2 ? 0.78 : tableSize === 3 ? 0.58 : 0.48;
    case 'sb':
      return tableSize <= 2 ? 0.78 : 0.42;
    case 'bb':
      return 0.28;
  }
}

function isPremium(hand: string): boolean {
  return hand === 'AA' || hand === 'KK' || hand === 'QQ' || hand === 'AKs' || hand === 'AKo';
}

function isThreeBetBluff(ctx: DecisionContext): boolean {
  const [a, b] = ctx.hole;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  return (
    (isSuitedAce(a, b) && lo <= 5) ||
    (isSuitedConnector(a, b, 1) && hi >= 8) ||
    (a.suit === b.suit && hi >= 11 && lo >= 9)
  );
}

function isFourBetBluff(ctx: DecisionContext): boolean {
  const [a, b] = ctx.hole;
  const lo = Math.min(a.rank, b.rank);
  return isSuitedAce(a, b) && lo <= 5;
}

/**
 * Easy mode intentionally retains the readable legacy range heuristic.
 */
function decidePreflopLegacy(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
): AIDecision {
  const { toCall, potBefore, canCheck, bigBlind, positionFactor } = ctx;
  const pct = preflopPercentile(ctx.hole[0], ctx.hole[1]);

  const posLean = p.positionAwareness * (positionFactor - 0.5);

  const skilled = difficulty !== 'easy';
  const facingOpen = toCall > 0 && toCall <= bigBlind * 3.5; // a normal-sized single raise
  const inBlinds = ctx.streetCommitted > 0 && ctx.streetCommitted <= bigBlind;
  // Callers already in the pot (squeeze spots): pot minus the raise minus blinds.
  const callersInPot =
    toCall >= bigBlind * 2 ? Math.max(0, Math.round((potBefore - toCall - bigBlind * 1.5) / toCall)) : 0;

  // Calling/playing range as a fraction of all hands.
  let playRange = p.vpip * (1 + posLean * 0.9) + exploit.stealBonus;
  if (toCall > 0 && potBefore > 0) {
    const priceRatio = toCall / potBefore; // bet size relative to pot
    playRange *= clamp(1.25 - priceRatio * 0.55, 0.45, 1.45); // cheap -> wider, pricey -> tighter
  }
  if (skilled && facingOpen) {
    // Cash-game defence vs a single open: position lets you realise equity, so
    // CO/BTN flat or 3-bet far more than "fold everything but premiums"; the
    // blinds already have money in and close the action, so they defend by price.
    if (positionFactor >= 0.7) playRange *= 1 + 0.35 * (0.5 + p.positionAwareness * 0.5);
    if (inBlinds) playRange *= ctx.streetCommitted >= bigBlind ? 2.0 : 1.5;
    // Dead money from callers makes flatting/squeezing more attractive.
    if (callersInPot > 0) playRange *= 1 + 0.12 * Math.min(2, callersInPot);
  }
  playRange = clamp(playRange, 0.03, 0.96);

  const raiseRange = clamp(
    p.vpip * p.pfr * (1 + posLean * 0.6) + exploit.stealBonus + (skilled && positionFactor >= 0.7 && facingOpen ? 0.03 : 0),
    0.02,
    playRange,
  );

  // A little noise so the same hand is not always the identical action.
  const noise = difficulty === 'easy' ? 0 : (rng() - 0.5) * 0.07;
  const strength = pct + noise;
  const playThresh = 1 - playRange;
  const raiseThresh = 1 - raiseRange;

  const reason = [`pct=${pct.toFixed(2)}`, `playR=${playRange.toFixed(2)}`, `raiseR=${raiseRange.toFixed(2)}`];
  const openSize = (canCheck ? 0.7 : 0.9) + rng() * 0.3;
  // Only ever shove pre-flop when genuinely short-stacked; otherwise keep raises
  // to a normal size (humans don't open-jam 100bb deep).
  const allowAllIn = isShortStack(ctx);
  // Stake budget: e.g. don't 4-bet a medium hand into a 30bb pre-flop pot.
  // A small random "budget mix" occasionally lifts the cap so strong-but-not-
  // premium hands can 3-bet/4-bet bluff — otherwise the budget cutoffs become a
  // perfect tell (big pre-flop raise == always QQ+/AK).
  let budget = preflopBudget(pct, bigBlind);
  if (difficulty !== 'easy' && Number.isFinite(budget) && rng() < 0.08) budget *= 2.2;
  const cap = budgetCapTarget(ctx, budget);
  const mayRaise = canRaiseWithinBudget(ctx, cap);

  // Unraised pot (big-blind option or limped to us): raise strong, else check.
  if (canCheck) {
    if (mayRaise && strength >= raiseThresh && rng() < 0.55 + p.pfr * 0.35) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn, cap);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-iso']);
    }
    return mk('check', 0, rng, false, [...reason, 'pf-check']);
  }

  // Facing a bet/raise. Squeezes (raise + callers) get a bigger size: one extra
  // bet-multiple per caller, as cash players do.
  const squeezeBonus = skilled ? callersInPot * 0.9 : 0;
  if (strength >= raiseThresh) {
    // With callers behind a raise, strong hands squeeze rather than flat (a
    // multiway flat with a premium bleeds equity).
    if (mayRaise && rng() < 0.5 + p.pfr * 0.4 + (callersInPot > 0 ? 0.25 : 0)) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn, cap, squeezeBonus);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, callersInPot > 0 ? 'pf-squeeze' : 'pf-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-trap-call'], true);
  }

  if (strength >= playThresh) {
    // Light 3-bet / squeeze-bluff: more from position, more for aggressive
    // personalities, and (hard) a bit more against an early-position human who
    // has shown they fold to pressure.
    let light3 = p.bluff * 0.4 * (positionFactor > 0.6 ? 1 : 0.35);
    if (!skilled) light3 *= 0.5;
    if (difficulty === 'hard' && ctx.aggressorIsHero) light3 += 0.06;
    if (callersInPot > 0 && positionFactor > 0.6) light3 += 0.05;
    if (mayRaise && (p.aggression > 0.45 || callersInPot > 0) && rng() < light3) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn, cap, squeezeBonus);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, callersInPot > 0 ? 'pf-squeeze-bluff' : 'pf-light-3bet'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-call'], true);
  }

  // Occasional pure steal from late position even with trash (not on easy).
  if (
    difficulty !== 'easy' &&
    mayRaise &&
    positionFactor > 0.78 &&
    toCall <= bigBlind * 1.5 &&
    rng() < p.bluff * 0.25 + exploit.stealBonus
  ) {
    const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn, cap);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'pf-steal'], true);
  }

  return mk('fold', 0, rng, false, [...reason, 'pf-fold']);
}

/**
 * Skilled post-flop strategy. It carries the pre-flop range into board-aware
 * sampling, recognises real draws/blockers, estimates fold equity and chooses
 * board/SPR-aware sizing. Hard differs through precision and exploit reads,
 * not by indiscriminately adding random bluffs.
 */
function decidePostflop(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
  iterationsOpt?: number,
): AIDecision {
  const iterations = iterationsOpt ?? (difficulty === 'hard' ? 720 : 480);
  const facingBet = ctx.toCall > 0;
  const features = analyseHand(ctx.hole, ctx.board);
  const wet = boardWetness(ctx.board);

  let rangeFraction = estimateRangeFraction({
    street: ctx.street,
    facingBet,
    toCall: ctx.toCall,
    pot: ctx.potBefore,
    betToPot: ctx.betToPot,
    aggressionCount: ctx.streetAggressionCount,
    preflopPotType: ctx.preflopPotType,
  });
  if (ctx.facingCheckRaise) rangeFraction *= 0.62;
  if (ctx.aggressorIsHero) rangeFraction *= exploit.rangeMult;
  rangeFraction = clamp(rangeFraction, 0.07, 0.88);

  let bluffShare = estimateBluffShare({
    facingBet,
    liveOpponents: Math.max(1, ctx.liveOpponents),
    wetness: wet,
    betToPot: ctx.betToPot,
    aggressionCount: ctx.streetAggressionCount,
    street: ctx.street,
  });
  if (ctx.facingCheckRaise) bluffShare *= 0.62;
  if (facingBet && ctx.aggressorIsHero) {
    const big = (ctx.betToPot ?? 0) >= 0.7;
    bluffShare *= big ? exploit.bluffReadBig : exploit.bluffReadSmall;
  }
  bluffShare = clamp(bluffShare, 0.03, 0.5);

  const preflopRange = preflopRangeForPostflop(ctx, exploit);
  const alreadyCalled =
    facingBet ? Math.max(0, ctx.liveOpponents - 1 - (ctx.playersBehind ?? 0)) : 0;
  const eq = estimateEquityVsRange({
    heroCards: ctx.hole,
    board: ctx.board,
    opponents: Math.max(1, ctx.liveOpponents),
    iterations,
    rng,
    rangeFraction,
    bluffShare,
    cappedCallers: alreadyCalled,
    preflopRangeFraction: preflopRange,
  }).equity;

  const { toCall, potBefore, canCheck, street } = ctx;
  const opponents = Math.max(1, ctx.liveOpponents);
  const hasDraw =
    street !== 'river' && (features.flushDraw || features.straightDraw);
  const inPosition = ctx.inPositionVsAggressor ?? ctx.positionFactor >= 0.6;
  const spr =
    potBefore > 0 ? Math.min(ctx.stack, ctx.effectiveStack ?? ctx.stack) / potBefore : 10;
  let valueThreshold = Math.min(0.82, 0.55 + Math.max(0, opponents - 1) * 0.07);
  valueThreshold -= clamp(ctx.recentImage - 0.3, 0, 0.4) * 0.1;
  const nutRange =
    eq >= 0.88 &&
    (features.category >= HandCategory.TwoPair ||
      features.pairKind === 'over' ||
      features.pairKind === 'top');
  const strongValue =
    eq >= valueThreshold &&
    (features.category >= HandCategory.Pair || street === 'river');

  let bluffFrequency = dynamicBluffFrequency(p, ctx) * exploit.bluffMult;
  const candidateMultiplier =
    0.18 + features.bluffQuality * 1.15 - features.showdownValue * 0.28;
  bluffFrequency *= clamp(candidateMultiplier, 0.05, 1.05);
  if (opponents > 1) bluffFrequency *= 0.72;
  const bluffCap = difficulty === 'hard' ? 0.46 : 0.36;
  bluffFrequency = clamp(bluffFrequency, 0, bluffCap);

  const mayRaise = ctx.canRaise !== false && ctx.maxRaiseTo > (ctx.currentBet ?? 0);
  const committed = isShortStack(ctx);
  const reason = [
    `eq=${eq.toFixed(2)}`,
    `vt=${valueThreshold.toFixed(2)}`,
    `rq=${rangeFraction.toFixed(2)}`,
    `pfR=${preflopRange.toFixed(2)}`,
    `bq=${features.bluffQuality.toFixed(2)}`,
  ];

  const valueSize = pickBetSize(p, ctx, features, nutRange, rng);
  const bluffSize = pickBetSize(p, ctx, features, true, rng);
  const thinSize = pickBetSize(p, ctx, features, false, rng);

  if (canCheck) {
    if (strongValue) {
      const dryEnoughToTrap = wet < 0.48 && features.category >= HandCategory.TwoPair;
      const trapChance =
        (exploit.trapMore ? 0.2 : 0) +
        (dryEnoughToTrap && !inPosition && ctx.villainWasAggressorLastStreet ? 0.12 : 0);
      if (mayRaise && rng() >= trapChance) {
        const size = nutRange ? valueSize : thinSize;
        const { amount, allIn } = sizeRaise(
          ctx,
          size,
          rng,
          committed && eq >= 0.72,
          Infinity,
          0,
          inPosition ? 2.7 : 3.15,
        );
        return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, nutRange ? 'polar-value' : 'thin-value']);
      }
      return mk('check', 0, rng, false, [...reason, 'value-trap']);
    }

    // A float/probe requires evidence that the prior aggressor has actually
    // checked. Acting first out of position is a different donk-lead strategy.
    const floatSpot =
      !!ctx.villainWasAggressorLastStreet &&
      !!ctx.villainCheckedToMe &&
      !ctx.wasAggressorLastStreet;
    if (floatSpot && mayRaise && opponents <= 2) {
      const foldEquity = estimateFoldEquity(ctx, exploit, bluffSize, features, false);
      const sized = sizeRaise(ctx, bluffSize, rng, committed, Infinity);
      const profitable =
        actionEV(
          eq,
          potBefore,
          sized.heroRisk,
          foldEquity,
          sized.callerContribution,
        ) > 0;
      const stabChance = clamp(
        (0.28 + (inPosition ? 0.2 : 0) + p.aggression * 0.12) *
          exploit.foldPressure *
          (0.45 + features.bluffQuality),
        0,
        0.72,
      );
      if (profitable && rng() < stabChance) {
        const { amount, allIn } = sized;
        return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'checked-to-float']);
      }
    }

    const barreling =
      !!ctx.wasAggressorLastStreet &&
      !!ctx.bluffedLastStreet &&
      !ctx.facingCheckRaise;
    if (barreling && mayRaise) {
      const lastBoardCard = ctx.board[ctx.board.length - 1];
      const highRunout = !!lastBoardCard && lastBoardCard.rank >= 11;
      const foldEquity = estimateFoldEquity(ctx, exploit, bluffSize, features, false);
      const sized = sizeRaise(ctx, bluffSize, rng, committed, Infinity);
      const profitable =
        actionEV(
          eq,
          potBefore,
          sized.heroRisk,
          foldEquity,
          sized.callerContribution,
        ) > 0;
      let barrelChance =
        (street === 'river' ? 0.34 : 0.52) +
        (highRunout ? 0.08 : 0) +
        features.bluffQuality * 0.18;
      barrelChance = clamp(barrelChance * exploit.bluffMult, 0, 0.72);
      if (profitable && rng() < barrelChance) {
        const { amount, allIn } = sized;
        return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'planned-barrel']);
      }
      return mk('check', 0, rng, false, [...reason, 'barrel-giveup']);
    }

    if (mayRaise && bluffFrequency > 0) {
      const foldEquity = estimateFoldEquity(ctx, exploit, bluffSize, features, false);
      const sized = sizeRaise(ctx, bluffSize, rng, committed, Infinity);
      if (
        actionEV(
          eq,
          potBefore,
          sized.heroRisk,
          foldEquity,
          sized.callerContribution,
        ) > 0 &&
        rng() < bluffFrequency
      ) {
        const { amount, allIn } = sized;
        return mk(
          allIn ? 'allin' : 'raise',
          amount,
          rng,
          true,
          [...reason, hasDraw ? 'candidate-semi-bluff' : 'blocker-bluff'],
        );
      }
    }
    return mk('check', 0, rng, false, [...reason, 'showdown-check']);
  }

  const directOdds = toCall / Math.max(1, potBefore + toCall);
  let needed = directOdds;
  if (hasDraw) {
    const cleanDraw = features.nutFlushDraw || features.openEnded || features.comboDraw;
    const depth = clamp((spr - 2) / 6, 0, 1);
    const impliedDiscount =
      depth * (inPosition ? 0.12 : 0.07) * (cleanDraw ? 1 : 0.62);
    needed *= 1 - impliedDiscount * (0.55 + p.stackReactivity * 0.45);
  }

  let edge = eq - needed;
  edge += (p.callDown - 0.5) * 0.055;
  // Position improves realisation only while cards remain; river pot odds are
  // not magically better merely because we act last.
  if (street !== 'river') {
    edge += p.positionAwareness * (ctx.positionFactor - 0.5) * 0.055;
  }
  edge += exploit.valueLean;
  const temperature = difficulty === 'hard' ? 0.038 : 0.048;
  let continueProbability = sigmoid(edge / temperature);
  if (directOdds <= 0.15 && eq > 0.17) continueProbability = Math.max(0.86, continueProbability);
  reason.push(`odds=${directOdds.toFixed(2)}`, `edge=${edge.toFixed(2)}`);

  if (rng() < continueProbability) {
    if (
      exploit.trapMore &&
      eq >= valueThreshold + 0.08 &&
      !committed &&
      rng() < 0.42
    ) {
      return mk('call', 0, rng, false, [...reason, 'exploit-trap-call'], true);
    }

    if (
      mayRaise &&
      eq >= valueThreshold + 0.08 &&
      features.category >= HandCategory.Pair &&
      rng() < 0.48 + p.aggression * 0.32
    ) {
      const size = nutRange ? valueSize : thinSize;
      const { amount, allIn } = sizeRaise(
        ctx,
        size,
        rng,
        committed && eq >= 0.7,
        Infinity,
        0,
        inPosition ? 2.7 : 3.2,
      );
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-raise'], true);
    }

    if (mayRaise && hasDraw && features.bluffQuality >= 0.35) {
      const foldEquity = estimateFoldEquity(ctx, exploit, bluffSize, features, true);
      const sized = sizeRaise(
        ctx,
        bluffSize,
        rng,
        committed,
        Infinity,
        0,
        inPosition ? 2.75 : 3.25,
      );
      if (
        actionEV(
          eq,
          potBefore,
          sized.heroRisk,
          foldEquity,
          sized.callerContribution,
        ) > 0 &&
        rng() < bluffFrequency * 0.72
      ) {
        const { amount, allIn } = sized;
        return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'equity-semi-raise'], true);
      }
    }
    return mk('call', 0, rng, false, [...reason, 'equity-call'], true);
  }

  if (
    mayRaise &&
    features.bluffQuality >= (street === 'river' ? 0.35 : 0.45) &&
    toCall <= potBefore * 0.7
  ) {
    const foldEquity = estimateFoldEquity(ctx, exploit, bluffSize, features, true);
    const sized = sizeRaise(
      ctx,
      bluffSize,
      rng,
      committed,
      Infinity,
      0,
      inPosition ? 2.8 : 3.3,
    );
    if (
      actionEV(
        eq,
        potBefore,
        sized.heroRisk,
        foldEquity,
        sized.callerContribution,
      ) > 0 &&
      rng() < bluffFrequency * 0.35
    ) {
      const { amount, allIn } = sized;
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'blocker-bluff-raise'], true);
    }
  }

  return mk('fold', 0, rng, false, [...reason, 'range-fold'], true);
}

function preflopRangeForPostflop(ctx: DecisionContext, exploit: Exploit): number {
  let fraction: number;
  switch (ctx.preflopPotType) {
    case 'fourBetPlus':
      fraction = 0.055;
      break;
    case 'threeBet':
      fraction = 0.12;
      break;
    case 'singleRaised':
      fraction =
        (ctx.aggressorPositionFactor ?? 0.5) >= 0.72
          ? 0.34
          : (ctx.aggressorPositionFactor ?? 0.5) <= 0.42
            ? 0.19
            : 0.26;
      break;
    case 'limped':
      fraction = 0.72;
      break;
    default:
      fraction = ctx.preflopRaised === false ? 0.72 : 0.3;
  }
  if (ctx.aggressorIsHero) fraction *= exploit.rangeMult;
  return clamp(fraction, 0.035, 0.86);
}

function estimateFoldEquity(
  ctx: DecisionContext,
  exploit: Exploit,
  size: number,
  features: HandFeatures,
  isRaise: boolean,
): number {
  let foldEquity = isRaise ? 0.3 : 0.39;
  foldEquity += (ctx.inPositionVsAggressor ?? ctx.positionFactor >= 0.6) ? 0.05 : 0;
  foldEquity -= Math.max(0, ctx.liveOpponents - 1) * 0.1;
  foldEquity += clamp(size - 0.5, -0.25, 0.65) * 0.13;
  foldEquity += features.blockerScore * 0.08;
  if (ctx.facingCheckRaise) foldEquity -= 0.16;
  if ((ctx.streetAggressionCount ?? 0) >= 2) foldEquity -= 0.1;
  foldEquity *= exploit.foldPressure;
  return clamp(foldEquity, 0.08, 0.72);
}

/**
 * Immediate EV relative to checking/folding. A bet has equal hero risk and
 * caller contribution; a raise does not, because part of the hero's risk first
 * calls the existing wager.
 */
export function actionEV(
  equity: number,
  pot: number,
  heroRisk: number,
  foldEquity: number,
  callerContribution = heroRisk,
): number {
  const calledEV =
    equity * (pot + heroRisk + callerContribution) - heroRisk;
  return foldEquity * pot + (1 - foldEquity) * calledEV;
}

/**
 * Post-flop: combine Monte-Carlo equity with pot odds. The continue decision is
 * a smooth probability around the break-even point (so play is not a robotic
 * hard cutoff), adjusted for implied odds on draws, position and personality.
 * On top of that, mixed strategies add slow-plays, semi-bluffs, thin value and
 * the occasional bluff-raise.
 */
function decidePostflopLegacy(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
  iterationsOpt?: number,
): AIDecision {
  const skilled = difficulty !== 'easy';
  const iterations = iterationsOpt ?? (skilled ? 420 : 320);

  // Skilled opponents (medium/hard) estimate equity against realistic ranges:
  // opponents who bet hold "top X% on this board" hands, and — crucially — that
  // betting range includes bluffs. Modelling bluffs is what lets these AIs
  // bluff-catch correctly, so a human can't print EV by barreling air at them.
  let eq: number;
  if (difficulty === 'easy') {
    eq = estimateEquity({
      heroCards: ctx.hole,
      board: ctx.board,
      opponents: Math.max(1, ctx.liveOpponents),
      iterations,
      rng,
      mode: 'random',
    }).equity;
  } else {
    const facingBet = ctx.toCall > 0;
    let rangeFraction = estimateRangeFraction({
      street: ctx.street,
      facingBet,
      toCall: ctx.toCall,
      pot: ctx.potBefore,
    });
    // Action-line awareness: a check-raise represents a much stronger range; a
    // pot nobody raised pre-flop means wide, capped opponent ranges.
    if (ctx.facingCheckRaise) rangeFraction *= 0.65;
    if (ctx.preflopRaised === false) rangeFraction = Math.min(0.85, rangeFraction * 1.25);

    const wetness = boardWetness(ctx.board);
    let bluffShare = estimateBluffShare({
      facingBet,
      liveOpponents: Math.max(1, ctx.liveOpponents),
      wetness,
    });
    if (ctx.facingCheckRaise) bluffShare *= 0.7;
    // Showdown-calibrated read of the HUMAN's bluffing habits (size-aware):
    // vs an honest human we stop paying off; vs a wild one we call down more.
    if (facingBet && ctx.aggressorIsHero) {
      const big = ctx.toCall > ctx.potBefore * 0.55;
      bluffShare *= big ? exploit.bluffReadBig : exploit.bluffReadSmall;
      bluffShare = clamp(bluffShare, 0, 0.6);
    }

    eq = estimateEquityVsRange({
      heroCards: ctx.hole,
      board: ctx.board,
      opponents: Math.max(1, ctx.liveOpponents),
      iterations,
      rng,
      rangeFraction,
      bluffShare,
      // Multiway: only one opponent is the bettor; the rest hold capped
      // calling ranges (their strongest combos would have raised).
      cappedCallers: facingBet ? Math.max(0, ctx.liveOpponents - 1) : 0,
    }).equity;
  }

  const { toCall, potBefore, canCheck, positionFactor, street } = ctx;
  const opp = ctx.liveOpponents;
  const cardsToCome = street === 'flop' || street === 'turn';

  // Value needs to be stronger multiway; draws are hands with cards to come and
  // moderate (not yet made) equity. An aggressive self-image means opponents
  // call lighter, so value can be bet thinner (and bluffs are cut elsewhere).
  let valueThresh = Math.min(0.82, 0.5 + 0.075 * opp);
  if (skilled) valueThresh -= clamp(ctx.recentImage - 0.3, 0, 0.4) * 0.12;
  const draw = cardsToCome && eq >= 0.3 && eq < valueThresh;
  // Stack-to-pot ratio: deep = implied odds for draws/set-mines, shallow = none.
  const spr = potBefore > 0 ? ctx.stack / potBefore : 10;
  const inPosition = positionFactor >= 0.6;

  // Keep bluffing balanced (believable) rather than spewy. Medium (the cash-game
  // simulation) bluffs at controlled cash-game frequencies; hard pushes harder.
  const bluffScale = difficulty === 'easy' ? 0.4 : difficulty === 'medium' ? 0.75 : 1.0;
  const bluffCap = difficulty === 'easy' ? 0.4 : difficulty === 'medium' ? 0.45 : 0.6;
  let bluffFreq = dynamicBluffFrequency(p, ctx) * exploit.bluffMult * bluffScale;
  bluffFreq = clamp(bluffFreq + exploit.stealBonus * 0.4, 0, bluffCap);

  const short = isShortStack(ctx);
  // Value and bluff share one sizing distribution (a bluff isn't readable by
  // size). Even monsters bet normal sizes when deep — in a cash game you build
  // the pot across streets; jamming only makes sense at a low-SPR commit spot.
  const betSize = pickBetSize(p, ctx, analyseHand(ctx.hole, ctx.board), false, rng);
  // Stake budget: a hand is only worth so much. Once this hand's investment
  // would exceed the strength-based budget, stop escalating (check/call/fold).
  // A rare budget mix lets non-nut hands occasionally play a bigger pot so
  // "still raising in a big pot" is not a 100% nut signal.
  let budget = investBudget(eq, ctx.bigBlind);
  if (skilled && Number.isFinite(budget) && rng() < 0.08) budget *= 2.2;
  const cap = budgetCapTarget(ctx, budget);
  const mayRaise = canRaiseWithinBudget(ctx, cap);

  const reason = [`eq=${eq.toFixed(2)}`, `vt=${valueThresh.toFixed(2)}`, `bf=${bluffFreq.toFixed(2)}`];

  // River sizing is polarised for skilled players: nut hands AND bluffs use the
  // big size (so the size never tells them apart), thin value uses a small one
  // that a marginal hand can call.
  const riverSize = (nutOrBluff: boolean): number => {
    if (!skilled || street !== 'river') return betSize;
    return nutOrBluff ? Math.max(betSize, 0.6 + rng() * 0.25) : Math.min(betSize, 0.33 + rng() * 0.15);
  };

  // ---- No bet to call: bet or check ----
  if (canCheck) {
    if (eq >= valueThresh) {
      // Sometimes slow-play a monster to disguise the hand; hard traps more
      // often against an aggressive human (check to induce bluffs). Out of
      // position vs the previous street's aggressor, checking to them (letting
      // them bluff) is also a natural line for strong hands.
      const trapBoost = exploit.trapMore ? 0.25 : 0;
      const oopTrap = skilled && !inPosition && !!ctx.villainWasAggressorLastStreet ? 0.12 : 0;
      const slowPlay = eq > 0.85 && rng() < 0.3 * (1 - p.aggression) + trapBoost + oopTrap;
      if (!slowPlay && mayRaise && rng() < 0.72 + p.aggression * 0.23) {
        const { amount, allIn } = sizeRaise(ctx, riverSize(eq >= 0.85), rng, short, cap);
        return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-bet']);
      }
      return mk('check', 0, rng, false, [...reason, 'slowplay-check']);
    }
    // Float / take-it-away: the other player drove the previous street and has
    // now checked to us. Their range is capped by that check, so a stab wins
    // often — especially in position. This is the core positional exploit vs
    // a human who c-bets once and gives up.
    const floatSpot = skilled && !!ctx.villainWasAggressorLastStreet && !ctx.wasAggressorLastStreet;
    if (floatSpot && mayRaise && opp <= 2) {
      let stab = 0.3 + (inPosition ? 0.25 : 0.05) + p.aggression * 0.15;
      stab *= exploit.bluffMult;
      if (street === 'river') stab *= 0.85;
      if (rng() < clamp(stab, 0, 0.75)) {
        const { amount, allIn } = sizeRaise(ctx, riverSize(true), rng, short, cap);
        return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'float-stab']);
      }
    }
    // Barrel plan: if we bluffed as the aggressor on the previous street, keep
    // telling the same story most of the time instead of independently
    // re-rolling (independent sampling made "call one bet, take it away on the
    // turn" a printing strategy for the human). High cards strengthen the
    // story; the river barrel is rarer (it's the committal one).
    const barreling =
      skilled && !!ctx.wasAggressorLastStreet && (ctx.myBluffsThisHand ?? 0) > 0 && !ctx.facingCheckRaise;
    if (barreling && mayRaise) {
      const highBoard = ctx.board.some((c) => c.rank >= 13);
      let barrelProb = (street === 'river' ? 0.4 : 0.6) + (highBoard ? 0.08 : 0);
      barrelProb = clamp(barrelProb * exploit.bluffMult, 0, 0.72);
      if (rng() < barrelProb) {
        const { amount, allIn } = sizeRaise(ctx, betSize, rng, short, cap);
        return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'barrel']);
      }
      return mk('check', 0, rng, false, [...reason, 'barrel-giveup']);
    }

    if (mayRaise && rng() < bluffFreq) {
      // Bluffs never shove off a deep stack (only when already short).
      const { amount, allIn } = sizeRaise(ctx, riverSize(true), rng, short, cap);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, draw ? 'semi-bluff' : 'bluff-bet']);
    }
    return mk('check', 0, rng, false, [...reason, 'check']);
  }

  // ---- Facing a bet: pot-odds-driven continuation ----
  const directOdds = toCall / (potBefore + toCall); // equity needed to call now
  let needed = directOdds;
  if (draw) {
    // Implied odds: draws win more later — more so in position (we see their
    // action first) and with deep stacks (there is more to win); a shallow SPR
    // leaves nothing to win when the draw comes in.
    let implied = inPosition ? 0.78 : 0.86;
    const depth = clamp((spr - 2) / 6, -0.3, 1); // <2 penalises, ~8 fully rewards
    implied -= depth * 0.08 * (0.5 + p.stackReactivity * 0.5);
    needed *= clamp(implied, 0.68, 0.95);
  }
  let edge = eq - needed;
  edge += (p.callDown - 0.5) * 0.08; // sticky players continue more; nits less
  edge += p.positionAwareness * (positionFactor - 0.5) * 0.09; // position helps realise equity
  edge += exploit.valueLean;

  // Skilled players (medium/hard) play close to the math; easy is noisier.
  const temperature = skilled ? 0.05 : 0.07;
  let contProb = sigmoid(edge / temperature);
  // Rarely fold when closing for a tiny price relative to the pot.
  if (directOdds <= 0.18 && eq > 0.18) contProb = Math.max(contProb, 0.8);

  reason.push(`odds=${directOdds.toFixed(2)}`, `edge=${edge.toFixed(2)}`);

  if (rng() < contProb) {
    // Trap: vs an over-aggressive human, flat-call strong hands more often and
    // let them keep bluffing into us instead of raising them off their air.
    if (exploit.trapMore && eq >= valueThresh + 0.06 && !short && rng() < 0.5) {
      return mk('call', 0, rng, false, [...reason, 'trap-call'], true);
    }
    // Continue: choose raise vs call with mixed frequencies (within budget).
    if (mayRaise && eq >= valueThresh + 0.06 && rng() < 0.45 + p.aggression * 0.4) {
      const { amount, allIn } = sizeRaise(ctx, riverSize(eq >= 0.85), rng, short, cap);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-raise'], true);
    }
    if (mayRaise && draw && rng() < bluffFreq * 0.6) {
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short, cap);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'semi-raise'], true);
    }
    if (mayRaise && eq >= valueThresh && rng() < p.aggression * 0.3) {
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short, cap);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'thin-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'odds-call'], true);
  }

  // Fold zone: occasionally turn it into a bluff-raise when cheap (never a deep shove).
  if (mayRaise && rng() < bluffFreq * 0.3 && toCall <= potBefore * 0.5) {
    const { amount, allIn } = sizeRaise(ctx, riverSize(true), rng, short, cap);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'bluff-raise'], true);
  }

  return mk('fold', 0, rng, false, [...reason, 'fold'], true);
}
