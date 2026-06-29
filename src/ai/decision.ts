import type { Rng } from '../engine/deck';
import { defaultRng } from '../engine/deck';
import type { Difficulty } from '../engine/gameTypes';
import { estimateEquity } from '../engine/monteCarlo';
import type { Personality, DecisionContext, AIDecision, HeroProfile } from './types';
import { dynamicBluffFrequency } from './dynamicBluff';
import { boardWetness } from './boardTexture';
import { preflopPercentile } from './preflop';

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
  // Commit rather than leave an awkward tiny stack behind.
  if (target >= ctx.maxRaiseTo * 0.85) {
    return { amount: ctx.maxRaiseTo, allIn: true };
  }
  target = Math.min(target, ctx.maxRaiseTo);
  return { amount: target, allIn: target >= ctx.maxRaiseTo };
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
}

function computeExploit(difficulty: Difficulty, ctx: DecisionContext, profile?: HeroProfile): Exploit {
  const base: Exploit = { bluffMult: 1, stealBonus: 0, valueLean: 0 };
  if (difficulty !== 'hard' || !profile || profile.hands <= 15) return base;

  if (profile.foldToSteal > 0.6 && ctx.positionFactor > 0.55) {
    base.stealBonus = (profile.foldToSteal - 0.6) * 0.6;
  }
  if (profile.foldToSteal > 0.55) base.bluffMult *= 1.3;
  if (profile.wentToShowdown > 0.45) base.bluffMult *= 0.6; // sticky hero -> bluff less
  if (profile.aggression > 0.6) {
    base.bluffMult *= 0.8;
    base.valueLean += 0.05; // call down a touch lighter vs maniacs
  }
  return base;
}

export function decide(opts: DecideOptions): AIDecision {
  const { personality: p, difficulty, ctx, rng = defaultRng, heroProfile } = opts;
  const exploit = computeExploit(difficulty, ctx, heroProfile);
  return ctx.street === 'preflop'
    ? decidePreflop(p, difficulty, ctx, rng, exploit)
    : decidePostflop(p, difficulty, ctx, rng, exploit, opts.iterations);
}

/**
 * Pre-flop: think in ranges. A hand's percentile is compared against a play /
 * raise range that widens with position, with a price discount (good pot odds
 * widen the calling range, big raises tighten it) and with HARD steal exploits.
 */
function decidePreflop(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
): AIDecision {
  const { toCall, potBefore, canCheck, bigBlind, positionFactor } = ctx;
  const pct = preflopPercentile(ctx.hole[0], ctx.hole[1]);

  const posLean = p.positionAwareness * (positionFactor - 0.5);

  // Calling/playing range as a fraction of all hands.
  let playRange = p.vpip * (1 + posLean * 0.9) + exploit.stealBonus;
  if (toCall > 0 && potBefore > 0) {
    const priceRatio = toCall / potBefore; // bet size relative to pot
    playRange *= clamp(1.25 - priceRatio * 0.55, 0.45, 1.45); // cheap -> wider, pricey -> tighter
  }
  playRange = clamp(playRange, 0.03, 0.96);

  const raiseRange = clamp(
    p.vpip * p.pfr * (1 + posLean * 0.6) + exploit.stealBonus,
    0.02,
    playRange,
  );

  // A little noise so the same hand is not always the identical action.
  const noise = difficulty === 'easy' ? 0 : (rng() - 0.5) * 0.07;
  const strength = pct + noise;
  const playThresh = 1 - playRange;
  const raiseThresh = 1 - raiseRange;

  const reason = [`pct=${pct.toFixed(2)}`, `playR=${playRange.toFixed(2)}`, `raiseR=${raiseRange.toFixed(2)}`];
  const openSize = (canCheck ? 0.85 : 1.05) + rng() * 0.45;

  // Unraised pot (big-blind option or limped to us): raise strong, else check.
  if (canCheck) {
    if (strength >= raiseThresh && rng() < 0.55 + p.pfr * 0.35) {
      const { amount, allIn } = chooseRaiseTarget(ctx, openSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-iso']);
    }
    return mk('check', 0, rng, false, [...reason, 'pf-check']);
  }

  // Facing a bet/raise.
  if (strength >= raiseThresh) {
    if (rng() < 0.5 + p.pfr * 0.4) {
      const { amount, allIn } = chooseRaiseTarget(ctx, openSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-trap-call'], true);
  }

  if (strength >= playThresh) {
    // Aggressive players occasionally turn a playable hand into a light 3-bet.
    if (p.aggression > 0.6 && positionFactor > 0.6 && rng() < p.bluff * 0.5) {
      const { amount, allIn } = chooseRaiseTarget(ctx, openSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'pf-light-3bet'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-call'], true);
  }

  // Occasional pure steal from late position even with trash (not on easy).
  if (
    difficulty !== 'easy' &&
    positionFactor > 0.75 &&
    toCall <= bigBlind * 1.5 &&
    rng() < p.bluff * 0.35 + exploit.stealBonus
  ) {
    const { amount, allIn } = chooseRaiseTarget(ctx, openSize, rng);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'pf-steal'], true);
  }

  return mk('fold', 0, rng, false, [...reason, 'pf-fold']);
}

/**
 * Post-flop: combine Monte-Carlo equity with pot odds. The continue decision is
 * a smooth probability around the break-even point (so play is not a robotic
 * hard cutoff), adjusted for implied odds on draws, position and personality.
 * On top of that, mixed strategies add slow-plays, semi-bluffs, thin value and
 * the occasional bluff-raise.
 */
function decidePostflop(
  p: Personality,
  difficulty: Difficulty,
  ctx: DecisionContext,
  rng: Rng,
  exploit: Exploit,
  iterationsOpt?: number,
): AIDecision {
  const iterations = iterationsOpt ?? 320;
  const eq = estimateEquity({
    heroCards: ctx.hole,
    board: ctx.board,
    opponents: Math.max(1, ctx.liveOpponents),
    iterations,
    rng,
    mode: difficulty === 'easy' ? 'random' : 'range',
  }).equity;

  const { toCall, potBefore, canCheck, positionFactor, street } = ctx;
  const opp = ctx.liveOpponents;
  const wet = boardWetness(ctx.board);
  const cardsToCome = street === 'flop' || street === 'turn';

  // Value needs to be stronger multiway; draws are hands with cards to come and
  // moderate (not yet made) equity.
  const valueThresh = Math.min(0.82, 0.5 + 0.075 * opp);
  const draw = cardsToCome && eq >= 0.3 && eq < valueThresh;

  let bluffFreq = dynamicBluffFrequency(p, ctx) * exploit.bluffMult;
  if (difficulty === 'easy') bluffFreq *= 0.4;
  bluffFreq = clamp(bluffFreq + exploit.stealBonus * 0.5, 0, 0.85);

  const valueSize = clamp(0.5 + p.aggression * 0.25 + wet * 0.15 + (rng() < 0.08 ? 0.6 : 0), 0.3, 1.8);
  const bluffSize = clamp(0.55 + p.aggression * 0.25 + wet * 0.2, 0.4, 1.4);

  const reason = [`eq=${eq.toFixed(2)}`, `vt=${valueThresh.toFixed(2)}`, `bf=${bluffFreq.toFixed(2)}`];

  // ---- No bet to call: bet or check ----
  if (canCheck) {
    if (eq >= valueThresh) {
      // Sometimes slow-play a monster to disguise the hand.
      const slowPlay = eq > 0.85 && rng() < 0.3 * (1 - p.aggression);
      if (!slowPlay && rng() < 0.72 + p.aggression * 0.23) {
        const { amount, allIn } = chooseRaiseTarget(ctx, valueSize, rng);
        return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-bet']);
      }
      return mk('check', 0, rng, false, [...reason, 'slowplay-check']);
    }
    if (rng() < bluffFreq) {
      const { amount, allIn } = chooseRaiseTarget(ctx, bluffSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, draw ? 'semi-bluff' : 'bluff-bet']);
    }
    return mk('check', 0, rng, false, [...reason, 'check']);
  }

  // ---- Facing a bet: pot-odds-driven continuation ----
  const directOdds = toCall / (potBefore + toCall); // equity needed to call now
  let needed = directOdds;
  if (draw) needed *= 0.82; // implied odds: drawing hands can win more later
  let edge = eq - needed;
  edge += (p.callDown - 0.5) * 0.08; // sticky players continue more; nits less
  edge += p.positionAwareness * (positionFactor - 0.5) * 0.05; // position helps
  edge += exploit.valueLean;

  let contProb = sigmoid(edge / 0.07);
  // Rarely fold when closing for a tiny price relative to the pot.
  if (directOdds <= 0.18 && eq > 0.18) contProb = Math.max(contProb, 0.8);

  reason.push(`odds=${directOdds.toFixed(2)}`, `edge=${edge.toFixed(2)}`);

  if (rng() < contProb) {
    // Continue: choose raise vs call with mixed frequencies.
    if (eq >= valueThresh + 0.06 && rng() < 0.45 + p.aggression * 0.4) {
      const { amount, allIn } = chooseRaiseTarget(ctx, valueSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-raise'], true);
    }
    if (draw && rng() < bluffFreq * 0.7) {
      const { amount, allIn } = chooseRaiseTarget(ctx, bluffSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'semi-raise'], true);
    }
    if (eq >= valueThresh && rng() < p.aggression * 0.3) {
      const { amount, allIn } = chooseRaiseTarget(ctx, valueSize, rng);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'thin-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'odds-call'], true);
  }

  // Fold zone: occasionally turn it into a bluff-raise when cheap.
  if (rng() < bluffFreq * 0.4 && toCall <= potBefore * 0.5) {
    const { amount, allIn } = chooseRaiseTarget(ctx, bluffSize, rng);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'bluff-raise'], true);
  }

  return mk('fold', 0, rng, false, [...reason, 'fold'], true);
}
