import type { Card } from '../engine/types';
import type { Difficulty } from '../engine/gameTypes';

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
  streetCommitted: number;
  /** AI's own recent aggressive image, 0..1 (higher = looks aggressive). */
  recentImage: number;
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
  bluffCaught: number;
  wentToShowdown: number;
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
  };
}
