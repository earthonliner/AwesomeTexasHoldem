import type { ActionRecord } from '../engine/gameTypes';
import type { GameState } from '../engine/gameTypes';
import { evaluateHand } from '../engine/handEvaluator';
import { HandCategory } from '../engine/types';
import { tablePositionFor } from './line';
import type { HeroProfile, PostflopStreet, StreetBetCounter } from './types';

export const POSTFLOP_STREETS: readonly PostflopStreet[] = ['flop', 'turn', 'river'];

const STREET_BET_COUNTERS: readonly StreetBetCounter[] = [
  'BetChances',
  'SmallBets',
  'MediumBets',
  'BigBets',
  'ContinuationChances',
  'ContinuationBets',
];

export type StreetCounterKey = `${PostflopStreet}${StreetBetCounter}`;

export function streetCounterKey(street: PostflopStreet, counter: StreetBetCounter): StreetCounterKey {
  return `${street}${counter}`;
}

/** Prior for the hero's fold rate to an opening river bet (hard-AI population). */
export const RIVER_FOLD_PRIOR = 0.45;

function emptyStreetCounters(): Record<StreetCounterKey, number> {
  const out = {} as Record<StreetCounterKey, number>;
  for (const street of POSTFLOP_STREETS) {
    for (const counter of STREET_BET_COUNTERS) out[streetCounterKey(street, counter)] = 0;
  }
  return out;
}

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
    foldToRiverBet: RIVER_FOLD_PRIOR,
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
      betOpportunities: 0,
      smallBets: 0,
      mediumBets: 0,
      bigBets: 0,
      continuationChances: 0,
      continuationBets: 0,
      raisesFaced: 0,
      raisesFolded: 0,
      riverBetsFaced: 0,
      riverBetFolds: 0,
      ...emptyStreetCounters(),
    },
  };
}

export interface StreetOpeningBets {
  opportunities: number;
  small: number;
  medium: number;
  big: number;
  continuationChances: number;
  continuationBets: number;
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
   * the bet was big (`isBigRiverBet`) and whether the shown hand was weak —
   * used for the river-honesty and bet-size-tell reads. This is a *shown-weak
   * bet rate*, not a bluff frequency: successful bluffs are never shown, so the
   * consumer must treat it as biased evidence and damp its influence.
   */
  riverBetShown?: { big: boolean; weak: boolean } | null;
  /**
   * Per post-flop street: whether the hero could open the betting, its opening
   * bet by size, and whether that chance followed its own aggression on the
   * previous street (continuation bets: c-bets and barrels).
   */
  openingBets?: Record<PostflopStreet, StreetOpeningBets>;
  /** Post-flop streets where the hero's bet or raise was raised, and how often it folded. */
  raisedAfterBetting?: { faced: number; folded: number };
  /** The hero faced the opening bet of the river (not a raise of its own bet). */
  riverBetFaced?: { folded: boolean } | null;
}

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);

/**
 * Single bet-size classification shared by profile recording and by the reads
 * that consume it: a river wager above this fraction of the pot before the bet
 * is "big". Recording and reading used to disagree (0.55 vs 0.70), so a 0.6-pot
 * bet was stored in the big bucket but read with the small-bet profile.
 */
export const RIVER_BIG_BET_TO_POT = 0.55;

export function isBigRiverBet(betToPot: number): boolean {
  return betToPot > RIVER_BIG_BET_TO_POT;
}

export type BetSizeClass = 'small' | 'medium' | 'big';

/**
 * Opening-bet size classes shared by the frequency counters and the read that
 * consumes them: a third-pot stab, a standard half-to-two-thirds bet, and a
 * pot-sized bet or overbet.
 */
export function betSizeClass(betToPot: number): BetSizeClass {
  return betToPot < 0.42 ? 'small' : betToPot < 0.85 ? 'medium' : 'big';
}

/** Wager relative to the pot before it, the same definition as `deriveLineContext.betToPot`. */
function wagerToPot(action: ActionRecord): number {
  const wager =
    action.raiseBy && action.raiseBy > 0 ? action.raiseBy : (action.chipsPutIn ?? action.amount);
  return wager / Math.max(1, action.potBefore);
}

/**
 * Build an observation summary for any human seat. Shared by local play and
 * the authoritative LAN room so both modes learn from identical evidence.
 */
export function summarizePlayerHand(game: GameState, playerId: number): HandSummary {
  const actions = game.history;
  const preflop = actions.filter((a) => a.street === 'preflop');
  const playerIndex = game.players.findIndex((p) => p.id === playerId);
  const playerPosition = playerIndex >= 0 ? tablePositionFor(game, playerIndex) : 'middle';

  let facedSteal = false;
  let heroFoldedToSteal = false;
  const firstRaiseIndex = preflop.findIndex((a) => AGGRESSIVE.has(a.type));
  if (firstRaiseIndex >= 0 && (playerPosition === 'sb' || playerPosition === 'bb')) {
    const open = preflop[firstRaiseIndex];
    const openerIndex = game.players.findIndex((p) => p.id === open.playerId);
    const openerPosition = openerIndex >= 0 ? tablePositionFor(game, openerIndex) : 'middle';
    const isLateOpen = openerPosition === 'co' || openerPosition === 'btn' || openerPosition === 'sb';
    const potWasUnopened = preflop
      .slice(0, firstRaiseIndex)
      .every((action) => action.type === 'fold');
    const playerHadNotEntered = preflop
      .slice(0, firstRaiseIndex)
      .every((a) => a.playerId !== playerId || a.type === 'check');
    const response = preflop.slice(firstRaiseIndex + 1).find((a) => a.playerId === playerId);
    if (
      potWasUnopened &&
      isLateOpen &&
      playerHadNotEntered &&
      response?.toCall &&
      response.toCall > 0
    ) {
      facedSteal = true;
      heroFoldedToSteal = response.type === 'fold';
    }
  }

  let facedCbet = false;
  let heroFoldedToCbet = false;
  let preflopAggressor = -1;
  for (const action of preflop) {
    if (AGGRESSIVE.has(action.type)) preflopAggressor = action.playerId;
  }
  if (preflopAggressor >= 0 && preflopAggressor !== playerId) {
    const flop = actions.filter((a) => a.street === 'flop');
    const cbetIndex = flop.findIndex(
      (a) => a.playerId === preflopAggressor && AGGRESSIVE.has(a.type),
    );
    if (cbetIndex >= 0) {
      const response = flop.slice(cbetIndex + 1).find((a) => a.playerId === playerId && a.toCall > 0);
      if (response) {
        facedCbet = true;
        heroFoldedToCbet = response.type === 'fold';
      }
    }
  }

  let riverBetShown: HandSummary['riverBetShown'] = null;
  if (game.revealed.includes(playerId) && game.board.length === 5) {
    const riverBet = [...actions]
      .reverse()
      .find((a) => a.street === 'river' && a.playerId === playerId && AGGRESSIVE.has(a.type));
    const player = game.players.find((p) => p.id === playerId);
    if (riverBet && player?.hole.length === 2) {
      const playerHand = evaluateHand([...player.hole, ...game.board]);
      const boardHand = evaluateHand(game.board);
      // Losing a value bet is not a bluff. Count only no-showdown-value hands
      // (high card or playing the board) as weak evidence.
      const weak =
        playerHand.category === HandCategory.HighCard || playerHand.score === boardHand.score;
      riverBetShown = { big: isBigRiverBet(wagerToPot(riverBet)), weak };
    }
  }

  const emptyStreet = (): StreetOpeningBets => ({
    opportunities: 0,
    small: 0,
    medium: 0,
    big: 0,
    continuationChances: 0,
    continuationBets: 0,
  });
  const openingBets: Record<PostflopStreet, StreetOpeningBets> = {
    flop: emptyStreet(),
    turn: emptyStreet(),
    river: emptyStreet(),
  };
  const streets = ['preflop', 'flop', 'turn', 'river'] as const;
  for (let s = 1; s < streets.length; s++) {
    const street = streets[s] as PostflopStreet;
    const first = actions.find((a) => a.street === street && a.playerId === playerId);
    if (!first || first.toCall > 0) continue;
    const bet = AGGRESSIVE.has(first.type);
    const tally = openingBets[street];
    tally.opportunities += 1;
    if (bet) tally[betSizeClass(wagerToPot(first))] += 1;
    const lastAggressor = [...actions]
      .reverse()
      .find((a) => a.street === streets[s - 1] && AGGRESSIVE.has(a.type));
    if (lastAggressor?.playerId === playerId) {
      tally.continuationChances += 1;
      if (bet) tally.continuationBets += 1;
    }
  }

  let riverBetFaced: HandSummary['riverBetFaced'] = null;
  const river = actions.filter((a) => a.street === 'river');
  const riverOpen = river.findIndex((a) => AGGRESSIVE.has(a.type));
  if (riverOpen >= 0 && river[riverOpen].playerId !== playerId) {
    const response = river
      .slice(riverOpen + 1)
      .find((a) => a.playerId === playerId && a.toCall > 0);
    if (response) riverBetFaced = { folded: response.type === 'fold' };
  }

  const raisedAfterBetting = { faced: 0, folded: 0 };
  for (let s = 1; s < streets.length; s++) {
    const onStreet = actions.filter((a) => a.street === streets[s]);
    const betIndex = onStreet.findIndex((a) => a.playerId === playerId && AGGRESSIVE.has(a.type));
    if (betIndex < 0) continue;
    const raiseIndex = onStreet.findIndex(
      (a, i) => i > betIndex && a.playerId !== playerId && AGGRESSIVE.has(a.type),
    );
    if (raiseIndex < 0) continue;
    const response = onStreet.slice(raiseIndex + 1).find((a) => a.playerId === playerId);
    if (!response || response.toCall <= 0) continue;
    raisedAfterBetting.faced += 1;
    if (response.type === 'fold') raisedAfterBetting.folded += 1;
  }

  return {
    heroId: playerId,
    actions,
    facedSteal,
    heroFoldedToSteal,
    heroReachedShowdown: game.revealed.includes(playerId),
    facedCbet,
    heroFoldedToCbet,
    riverBetShown,
    openingBets,
    raisedAfterBetting,
    riverBetFaced,
  };
}

/**
 * Fold a completed hand's actions into the running profile. Reported rates use
 * Bayesian priors, so one rare opportunity cannot create a 0%/100% read.
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
  if (summary.openingBets) {
    for (const street of POSTFLOP_STREETS) {
      const t = summary.openingBets[street];
      c.betOpportunities += t.opportunities;
      c.smallBets += t.small;
      c.mediumBets += t.medium;
      c.bigBets += t.big;
      c.continuationChances += t.continuationChances;
      c.continuationBets += t.continuationBets;
      c[streetCounterKey(street, 'BetChances')] += t.opportunities;
      c[streetCounterKey(street, 'SmallBets')] += t.small;
      c[streetCounterKey(street, 'MediumBets')] += t.medium;
      c[streetCounterKey(street, 'BigBets')] += t.big;
      c[streetCounterKey(street, 'ContinuationChances')] += t.continuationChances;
      c[streetCounterKey(street, 'ContinuationBets')] += t.continuationBets;
    }
  }
  if (summary.raisedAfterBetting) {
    c.raisesFaced += summary.raisedAfterBetting.faced;
    c.raisesFolded += summary.raisedAfterBetting.folded;
  }
  if (summary.riverBetFaced) {
    c.riverBetsFaced += 1;
    if (summary.riverBetFaced.folded) c.riverBetFolds += 1;
  }

  const ratio = (num: number, den: number, prior: number, priorWeight: number) =>
    (num + prior * priorWeight) / (den + priorWeight);

  return {
    hands: c.handsDealt,
    vpip: ratio(c.voluntaryActions, c.handsDealt, 0.3, 8),
    pfr: ratio(c.preflopRaises, c.handsDealt, 0.18, 8),
    foldToSteal: ratio(c.stealFacedFolds, c.stealFaced, 0.5, 5),
    aggression: ratio(c.aggressiveActions, c.aggressiveActions + c.passiveActions, 0.5, 10),
    bluffCaught: ratio(c.riverBetsWeak, c.riverBetsShown, 0.3, 5),
    wentToShowdown: ratio(c.showdowns, c.handsDealt, 0.3, 8),
    foldToCbet: ratio(c.cbetFolded, c.cbetFaced, 0.5, 5),
    foldToRiverBet: ratio(c.riverBetFolds, c.riverBetsFaced, RIVER_FOLD_PRIOR, 8),
    counters: c,
  };
}
