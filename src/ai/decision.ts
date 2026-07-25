import type { Rng } from '../engine/deck';
import { defaultRng } from '../engine/deck';
import type { Difficulty } from '../engine/gameTypes';
import {
  estimateEquity,
  estimateEquityVsRange,
  estimateRangeFraction,
  estimateBluffShare,
} from '../engine/monteCarlo';
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

/** True when the stack is short relative to the pot — a natural commit spot. */
function isShortStack(ctx: DecisionContext): boolean {
  const potAfterCall = ctx.potBefore + ctx.toCall;
  return ctx.stack <= potAfterCall * 1.25;
}

/**
 * Size a bet/raise as a fraction of the pot. Humans rarely jam all-in for many
 * times the pot, so we only convert to an all-in when it is a genuine commit
 * spot (`allowAllIn`): a short stack, or near-committed sizing. Otherwise the
 * size is capped so chips are left behind instead of shoving.
 */
function sizeRaise(
  ctx: DecisionContext,
  fraction: number,
  rng: Rng,
  allowAllIn: boolean,
): { amount: number; allIn: boolean } {
  const currentLevel = ctx.streetCommitted + ctx.toCall;
  const potAfterCall = ctx.potBefore + ctx.toCall;
  const jitter = 0.9 + rng() * 0.2;
  const raiseBy = Math.max(ctx.bigBlind, Math.round(potAfterCall * fraction * jitter));
  let target = Math.max(currentLevel + raiseBy, ctx.minRaiseTo);

  if (target >= ctx.maxRaiseTo) return { amount: ctx.maxRaiseTo, allIn: true };
  if (allowAllIn && target >= ctx.maxRaiseTo * 0.85) {
    // Already nearly all-in: commit rather than leave dust behind.
    return { amount: ctx.maxRaiseTo, allIn: true };
  }
  if (!allowAllIn) {
    // Never shove off a deep stack on a normal bet/bluff; cap below all-in.
    target = Math.min(target, Math.round(ctx.maxRaiseTo * 0.7));
    target = Math.max(target, ctx.minRaiseTo);
  }
  target = Math.min(target, ctx.maxRaiseTo);
  return { amount: target, allIn: target >= ctx.maxRaiseTo };
}

/**
 * A single bet-sizing distribution used for BOTH value bets and bluffs, so a
 * bluff is not betrayed by an unusual size. Mostly half-to-three-quarter pot,
 * a touch larger on wet boards, with the occasional (rare) overbet.
 */
function pickBetSize(aggression: number, wet: number, rng: Rng): number {
  let f = 0.45 + aggression * 0.2 + wet * 0.12;
  if (rng() < 0.06) f += 0.45; // rare overbet for balance
  return Math.min(1.2, Math.max(0.33, f + (rng() - 0.5) * 0.1));
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
}

/**
 * Exploitative adjustments against the observed human style. Medium opponents
 * exploit at reduced intensity (a good regular reading the table); hard applies
 * the full read plus trapping.
 */
function computeExploit(difficulty: Difficulty, ctx: DecisionContext, profile?: HeroProfile): Exploit {
  const base: Exploit = { bluffMult: 1, stealBonus: 0, valueLean: 0, trapMore: false };
  if (difficulty === 'easy' || !profile || profile.hands <= 15) return base;
  const intensity = difficulty === 'hard' ? 1 : 0.55;

  if (profile.foldToSteal > 0.6 && ctx.positionFactor > 0.55) {
    base.stealBonus = (profile.foldToSteal - 0.6) * 0.6 * intensity;
  }
  if (profile.foldToSteal > 0.55) base.bluffMult *= 1 + 0.3 * intensity;
  if (profile.wentToShowdown > 0.45) base.bluffMult *= 1 - 0.4 * intensity; // sticky -> bluff less
  if (profile.aggression > 0.6) {
    base.bluffMult *= 1 - 0.2 * intensity;
    base.valueLean += 0.05 * intensity; // call down lighter vs maniacs
    base.trapMore = difficulty === 'hard';
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
  const openSize = (canCheck ? 0.85 : 1.05) + rng() * 0.4;
  // Only ever shove pre-flop when genuinely short-stacked; otherwise keep raises
  // to a normal size (humans don't open-jam 100bb deep).
  const allowAllIn = isShortStack(ctx);

  // Unraised pot (big-blind option or limped to us): raise strong, else check.
  if (canCheck) {
    if (strength >= raiseThresh && rng() < 0.55 + p.pfr * 0.35) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-iso']);
    }
    return mk('check', 0, rng, false, [...reason, 'pf-check']);
  }

  // Facing a bet/raise.
  if (strength >= raiseThresh) {
    if (rng() < 0.5 + p.pfr * 0.4) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'pf-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-trap-call'], true);
  }

  if (strength >= playThresh) {
    // Aggressive players occasionally turn a playable hand into a light 3-bet.
    if (p.aggression > 0.6 && positionFactor > 0.6 && rng() < p.bluff * 0.4) {
      const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'pf-light-3bet'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'pf-call'], true);
  }

  // Occasional pure steal from late position even with trash (not on easy).
  if (
    difficulty !== 'easy' &&
    positionFactor > 0.78 &&
    toCall <= bigBlind * 1.5 &&
    rng() < p.bluff * 0.25 + exploit.stealBonus
  ) {
    const { amount, allIn } = sizeRaise(ctx, openSize, rng, allowAllIn);
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
  const iterations = iterationsOpt ?? (difficulty === 'hard' ? 420 : 320);

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
    const rangeFraction = estimateRangeFraction({
      street: ctx.street,
      facingBet,
      toCall: ctx.toCall,
      pot: ctx.potBefore,
    });
    const wetness = boardWetness(ctx.board);
    const fullBluffShare = estimateBluffShare({
      facingBet,
      liveOpponents: Math.max(1, ctx.liveOpponents),
      wetness,
    });
    // Hard reads bettors' bluff share accurately; medium partially discounts it.
    const bluffShare = difficulty === 'hard' ? fullBluffShare : fullBluffShare * 0.6;
    eq = estimateEquityVsRange({
      heroCards: ctx.hole,
      board: ctx.board,
      opponents: Math.max(1, ctx.liveOpponents),
      iterations,
      rng,
      rangeFraction,
      bluffShare,
    }).equity;
  }

  const { toCall, potBefore, canCheck, positionFactor, street } = ctx;
  const opp = ctx.liveOpponents;
  const wet = boardWetness(ctx.board);
  const cardsToCome = street === 'flop' || street === 'turn';

  // Value needs to be stronger multiway; draws are hands with cards to come and
  // moderate (not yet made) equity.
  const valueThresh = Math.min(0.82, 0.5 + 0.075 * opp);
  const draw = cardsToCome && eq >= 0.3 && eq < valueThresh;

  // Keep bluffing balanced (believable) rather than spewy. Medium in particular
  // is capped so no opponent over-bluffs and becomes easy to read; hard leans on
  // exploits (not raw frequency) for its edge.
  const bluffScale = difficulty === 'easy' ? 0.4 : difficulty === 'medium' ? 0.7 : 1.0;
  const bluffCap = difficulty === 'easy' ? 0.4 : difficulty === 'medium' ? 0.42 : 0.6;
  let bluffFreq = dynamicBluffFrequency(p, ctx) * exploit.bluffMult * bluffScale;
  bluffFreq = clamp(bluffFreq + exploit.stealBonus * 0.4, 0, bluffCap);

  const short = isShortStack(ctx);
  // Value and bluff share one sizing distribution (a bluff isn't readable by size).
  const betSize = pickBetSize(p.aggression, wet, rng);
  const strongValue = eq >= 0.9;

  const reason = [`eq=${eq.toFixed(2)}`, `vt=${valueThresh.toFixed(2)}`, `bf=${bluffFreq.toFixed(2)}`];

  // ---- No bet to call: bet or check ----
  if (canCheck) {
    if (eq >= valueThresh) {
      // Sometimes slow-play a monster to disguise the hand; hard traps more
      // often against an aggressive human (check to induce bluffs).
      const trapBoost = exploit.trapMore ? 0.25 : 0;
      const slowPlay = eq > 0.85 && rng() < 0.3 * (1 - p.aggression) + trapBoost;
      if (!slowPlay && rng() < 0.72 + p.aggression * 0.23) {
        const { amount, allIn } = sizeRaise(ctx, betSize, rng, short || strongValue);
        return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-bet']);
      }
      return mk('check', 0, rng, false, [...reason, 'slowplay-check']);
    }
    if (rng() < bluffFreq) {
      // Bluffs never shove off a deep stack (only when already short).
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short);
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

  // Hard plays closer to the math (sharper threshold); others are noisier.
  const temperature = difficulty === 'hard' ? 0.05 : 0.07;
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
    // Continue: choose raise vs call with mixed frequencies.
    if (eq >= valueThresh + 0.06 && rng() < 0.45 + p.aggression * 0.4) {
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short || strongValue);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'value-raise'], true);
    }
    if (draw && rng() < bluffFreq * 0.6) {
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short);
      return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'semi-raise'], true);
    }
    if (eq >= valueThresh && rng() < p.aggression * 0.3) {
      const { amount, allIn } = sizeRaise(ctx, betSize, rng, short || strongValue);
      return mk(allIn ? 'allin' : 'raise', amount, rng, false, [...reason, 'thin-raise'], true);
    }
    return mk('call', 0, rng, false, [...reason, 'odds-call'], true);
  }

  // Fold zone: occasionally turn it into a bluff-raise when cheap (never a deep shove).
  if (rng() < bluffFreq * 0.3 && toCall <= potBefore * 0.5) {
    const { amount, allIn } = sizeRaise(ctx, betSize, rng, short);
    return mk(allIn ? 'allin' : 'raise', amount, rng, true, [...reason, 'bluff-raise'], true);
  }

  return mk('fold', 0, rng, false, [...reason, 'fold'], true);
}
