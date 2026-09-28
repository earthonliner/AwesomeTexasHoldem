import type { Card } from '../engine/types';
import type { Difficulty } from '../engine/gameTypes';

export type TablePosition = 'early' | 'middle' | 'hj' | 'co' | 'btn' | 'sb' | 'bb';
export type PreflopPotType = 'unopened' | 'limped' | 'singleRaised' | 'threeBet' | 'fourBetPlus';

/**
 * A continuous personality vector. Each field is 0..1 and is fixed for the
 * lifetime of an opponent at the table (regenerated only when the table resets).
 */
export interface Personality {
  /** Voluntarily-put-money-in-pot frequency: how loose the player is. */
  vpip: number;
  /** Pre-flop raise frequency relative to vpip: how aggressive pre-flop. */
  pfr: number;
  /** Post-flop aggression: bet/raise vs check/call lean. */
  aggression: number;
  /** Baseline bluff frequency (modulated dynamically by the situation). */
  bluff: number;
  /** Call-down tendency: reluctance to fold once invested. */
  callDown: number;
  /** Position awareness: how much position widens/tightens ranges. */
  positionAwareness: number;
  /** Reaction to stack depth (tightens when shallow / loosens when deep). */
  stackReactivity: number;
  /** Reaction to pot size (pot-control vs pressure). */
  potReactivity: number;
}

export interface OpponentProfileSeed {
  personality: Personality;
  difficulty: Difficulty;
  /** Stable label shown to the player, e.g. "AI3". */
  name: string;
}

/** Snapshot of the situation handed to the AI to make a decision. */
export interface DecisionContext {
  hole: [Card, Card];
  board: Card[];
  /** Number of opponents still live (excluding the deciding AI). */
  liveOpponents: number;
  potBefore: number;
  toCall: number;
  /** Player's remaining stack in chips. */
  stack: number;
  bigBlind: number;
  /** 0 = earliest position, 1 = button/latest. */
  positionFactor: number;
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  canCheck: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  /** Whether betting/raising is legally available (short all-ins may not reopen it). */
  canRaise?: boolean;
  /** Current wager level on this street. */
  currentBet?: number;
  streetCommitted: number;
  /** Chips this player has invested across the whole hand (for stake budgeting). */
  totalCommitted: number;
  /** AI's own recent aggressive image, 0..1 (higher = looks aggressive). */
  recentImage: number;
  /** Remaining effective stack against the relevant aggressor. */
  effectiveStack?: number;
  tableSize?: number;
  position?: TablePosition;
  playersBehind?: number;
  /**
   * Live opponents whose chips are already committed at the current level:
   * all-in players plus everyone who has matched the current bet. They all
   * contest the pot regardless of what the players still to act do.
   */
  committedOpponents?: number;
  /**
   * Chips we can still win once we call: the pot layers we are eligible for,
   * including our own call. Less than `potBefore + toCall` when we are all-in
   * for less than the bet (the excess goes back or to a side pot).
   */
  winnablePot?: number;
  /** Live opponents who are already all-in, when there are any. */
  allIn?: AllInOpponents;

  // ---- Hand story-line (optional; derived from the action history) ----
  /** This player made the last aggressive action on the previous street. */
  wasAggressorLastStreet?: boolean;
  /** Someone else drove the previous street and has now slowed down. */
  villainWasAggressorLastStreet?: boolean;
  /** How many bluffs this player has already fired in this hand. */
  myBluffsThisHand?: number;
  /** The previous street's aggressive action was explicitly a bluff/semi-bluff. */
  bluffedLastStreet?: boolean;
  /** The current street's bettor checked earlier this street (check-raise). */
  facingCheckRaise?: boolean;
  /** The current street's last aggressor is the human hero (single-player). */
  aggressorIsHero?: boolean;
  /** Profiled player responsible for the relevant current/previous aggression. */
  profiledPlayerId?: number;
  /** Accurate size of the wager faced relative to the pot before that wager. */
  betToPot?: number;
  /** Number of aggressive actions already made on the current street. */
  streetAggressionCount?: number;
  /** Previous-street aggressor has actually checked on this street before us. */
  villainCheckedToMe?: boolean;
  /** This AI checked earlier on the current street. */
  checkedThisStreet?: boolean;
  /** Every recorded action on the previous post-flop street was a check. */
  previousStreetCheckedThrough?: boolean;
  /** Position relative to the current/previous aggressor after the flop. */
  inPositionVsAggressor?: boolean;
  /** false when the pot was limped pre-flop (weak, capped opponent ranges). */
  preflopRaised?: boolean;
  preflopPotType?: PreflopPotType;
  preflopRaiseCount?: number;
  limpers?: number;
  callersAfterRaise?: number;
  aggressorPositionFactor?: number;
  /** Table position of the relevant aggressor (stable, unlike the live factor). */
  aggressorPosition?: TablePosition;
  /** Table position of the last pre-flop aggressor. */
  preflopAggressorPosition?: TablePosition;
  /**
   * The opponent whose pre-flop range the post-flop model should assume: the
   * current/previous-street aggressor when that is an opponent, otherwise the
   * pre-flop raiser, otherwise the widest live caller (big blind first).
   */
  rangeOpponentPosition?: TablePosition;
  /** Whether that opponent was the last pre-flop aggressor (raiser) or a caller. */
  rangeOpponentRaisedPreflop?: boolean;
  /** Whether that opponent is a profiled (human) player. */
  rangeOpponentIsProfiled?: boolean;
}

/**
 * All-in opponents contest the pot layers they are eligible for, but can
 * neither fold nor put in more chips: fold equity comes only from the others,
 * and new chips go to a side pot the all-in players cannot win.
 */
export interface AllInOpponents {
  opponents: number;
  /** Of those, the ones that went all-in before this street and have not acted on it. */
  idle: number;
  /** Share of their range the idle ones are sampled from: 1 pre-flop, less when they committed later. */
  idleShare: number;
  /** The bet or raise being faced on this street is an opponent's all-in. */
  bettor: boolean;
  /** All-in opponents who acted on this street without being its last aggressor. */
  callers: number;
  /** Chips in the pot layers they contest together with us (counting our call). */
  pot: number;
  /** The current or previous street's aggressor is all-in: nobody is left to check to. */
  aggressor: boolean;
}

export interface AIDecision {
  action: 'fold' | 'check' | 'call' | 'raise' | 'allin';
  /** Target streetCommitted level for raise/allin. */
  amount: number;
  /** Simulated thinking delay in milliseconds for natural pacing. */
  thinkMs: number;
  /** Internal reasoning trace (for debugging / decision review). */
  reason: string;
  /** True when this action is a bluff (weak hand betting/raising). */
  isBluff: boolean;
}

export type PostflopStreet = 'flop' | 'turn' | 'river';

/**
 * Opening-bet counters kept per post-flop street, e.g. `flopMediumBets`: the
 * chances to open the betting, the opening bets there by size class, and the
 * subset of chances that followed the hero's own aggression on the previous
 * street (c-bets and barrels).
 */
export type StreetBetCounter =
  | 'BetChances'
  | 'SmallBets'
  | 'MediumBets'
  | 'BigBets'
  | 'ContinuationChances'
  | 'ContinuationBets';

/**
 * Observed behavioural profile of the hero, accumulated across many hands and
 * used by HARD opponents to exploit. All rates are smoothed estimates 0..1.
 */
export interface HeroProfile {
  hands: number;
  vpip: number;
  pfr: number;
  foldToSteal: number;
  aggression: number;
  /** Share of the hero's shown-down river bets that were weak (bluff proxy). */
  bluffCaught: number;
  wentToShowdown: number;
  /** How often the hero folds to a flop continuation bet. */
  foldToCbet: number;
  /** How often the hero folds to the opening bet of a river. */
  foldToRiverBet: number;
  /** Raw counters used to derive the smoothed rates above. */
  counters: {
    handsDealt: number;
    voluntaryActions: number;
    preflopRaises: number;
    stealFacedFolds: number;
    stealFaced: number;
    aggressiveActions: number;
    passiveActions: number;
    showdowns: number;
    cbetFaced: number;
    cbetFolded: number;
    /** Hero river bets that reached showdown, split by bet size (size tell). */
    riverBetsShown: number;
    riverBetsWeak: number;
    riverBigShown: number;
    riverBigWeak: number;
    riverSmallShown: number;
    riverSmallWeak: number;
    /**
     * Post-flop streets on which the hero could open the betting (first to
     * act, or checked to), and the opening bets made there by size class
     * (`betSizeClass`), summed over the streets. Unlike the river counters
     * this needs no showdown. The per-street split is kept alongside.
     */
    betOpportunities: number;
    smallBets: number;
    mediumBets: number;
    bigBets: number;
    /** Of those, streets where the hero drove the previous street, and its bets there. */
    continuationChances: number;
    continuationBets: number;
    /** Post-flop streets where a hero bet or raise was raised, and the folds there. */
    raisesFaced: number;
    raisesFolded: number;
    /** Rivers where the hero faced the opening bet, and the folds to it. */
    riverBetsFaced: number;
    riverBetFolds: number;
  } & Record<`${PostflopStreet}${StreetBetCounter}`, number>;
}
