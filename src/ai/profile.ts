import type { ActionRecord } from '../engine/gameTypes';
import type { HeroProfile } from './types';

export function emptyHeroProfile(): HeroProfile {
  return {
    hands: 0,
    vpip: 0.3,
    pfr: 0.15,
    foldToSteal: 0.5,
    aggression: 0.5,
    bluffCaught: 0.3,
    wentToShowdown: 0.3,
    foldToCbet: 0.5,
    counters: {
      handsDealt: 0,
      voluntaryActions: 0,
      preflopRaises: 0,
      stealFacedFolds: 0,
      stealFaced: 0,
      aggressiveActions: 0,
      passiveActions: 0,
      showdowns: 0,
      cbetFaced: 0,
      cbetFolded: 0,
      riverBetsShown: 0,
      riverBetsWeak: 0,
      riverBigShown: 0,
      riverBigWeak: 0,
      riverSmallShown: 0,
      riverSmallWeak: 0,
    },
  };
}

export interface HandSummary {
  heroId: number;
  actions: ActionRecord[];
  /** Whether the hero faced a single late-position open (a "steal" spot). */
  facedSteal: boolean;
  heroFoldedToSteal: boolean;
  heroReachedShowdown: boolean;
  /** Hero faced a flop c-bet from the pre-flop aggressor. */
  facedCbet?: boolean;
  heroFoldedToCbet?: boolean;
  /**
   * Hero bet/raised the river AND the hand reached showdown: records whether
   * the bet was big (> ~55% pot) and whether the shown hand was weak (lost) —
   * used for the river-honesty and bet-size-tell reads.
   */
  riverBetShown?: { big: boolean; weak: boolean } | null;
}

/**
 * Fold a completed hand's hero actions into the running profile. Uses simple
 * exponential smoothing so the profile adapts but stays stable. Returns a new
 * object (does not mutate the input).
 */
export function updateHeroProfile(profile: HeroProfile, summary: HandSummary): HeroProfile {
  const c = { ...profile.counters };
  c.handsDealt += 1;

  let voluntary = false;
  let preflopRaise = false;
  let aggressive = 0;
  let passive = 0;

  for (const a of summary.actions) {
    if (a.playerId !== summary.heroId) continue;
    if (a.street === 'preflop') {
      if (a.type === 'call' || a.type === 'bet' || a.type === 'raise' || a.type === 'allin') {
        // A call of the big blind option is not strictly voluntary, but a call
        // facing a raise (toCall beyond the blind) counts.
        if (a.type !== 'call' || a.toCall > 0) voluntary = true;
      }
      if (a.type === 'raise' || a.type === 'allin' || a.type === 'bet') preflopRaise = true;
    }
    if (a.type === 'bet' || a.type === 'raise' || a.type === 'allin') aggressive += 1;
    if (a.type === 'call' || a.type === 'check') passive += 1;
  }

  if (voluntary) c.voluntaryActions += 1;
  if (preflopRaise) c.preflopRaises += 1;
  c.aggressiveActions += aggressive;
  c.passiveActions += passive;
  if (summary.facedSteal) {
    c.stealFaced += 1;
    if (summary.heroFoldedToSteal) c.stealFacedFolds += 1;
  }
  if (summary.heroReachedShowdown) c.showdowns += 1;
  if (summary.facedCbet) {
    c.cbetFaced += 1;
    if (summary.heroFoldedToCbet) c.cbetFolded += 1;
  }
  if (summary.riverBetShown) {
    c.riverBetsShown += 1;
    if (summary.riverBetShown.weak) c.riverBetsWeak += 1;
    if (summary.riverBetShown.big) {
      c.riverBigShown += 1;
      if (summary.riverBetShown.weak) c.riverBigWeak += 1;
    } else {
      c.riverSmallShown += 1;
      if (summary.riverBetShown.weak) c.riverSmallWeak += 1;
    }
  }

  const ratio = (num: number, den: number, fallback: number) => (den > 0 ? num / den : fallback);

  return {
    hands: c.handsDealt,
    vpip: ratio(c.voluntaryActions, c.handsDealt, profile.vpip),
    pfr: ratio(c.preflopRaises, c.handsDealt, profile.pfr),
    foldToSteal: ratio(c.stealFacedFolds, c.stealFaced, profile.foldToSteal),
    aggression: ratio(c.aggressiveActions, c.aggressiveActions + c.passiveActions, profile.aggression),
    bluffCaught: ratio(c.riverBetsWeak, c.riverBetsShown, profile.bluffCaught),
    wentToShowdown: ratio(c.showdowns, c.handsDealt, profile.wentToShowdown),
    foldToCbet: ratio(c.cbetFolded, c.cbetFaced, profile.foldToCbet),
    counters: c,
  };
}
