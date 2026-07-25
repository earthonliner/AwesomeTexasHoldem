import type { Card } from '../engine/types';
import type { ActionRecord, Difficulty } from '../engine/gameTypes';
import type { Payout } from '../engine/sidePots';
import type { Personality, HeroProfile } from '../ai/types';
import type { FoldOutcome } from '../utils/analysis';

export interface Settings {
  seatCount: number;
  blindLevel: number;
  startingStackBB: number;
  /** Chips-per-big-blind display ratio: 1 (show $) / 10 / 20 (show chips). */
  chipRatio: number;
  difficulty: Difficulty;
  sound: boolean;
  /** Master enable for the objective math panel (still collapsed by default). */
  mathEnabled: boolean;
  /** HUD opponent stats overlay (off by default, by design). */
  hudEnabled: boolean;
  /** Reduce AI thinking delays for faster sessions. */
  fastMode: boolean;
}

export interface Stats {
  handsPlayed: number;
  netChips: number;
  profitCurve: number[];
  biggestPotWon: number;
  showdownsWon: number;
  showdownsSeen: number;
  handsWon: number;
}

export interface Seat {
  id: number;
  name: string;
  isHero: boolean;
  personality: Personality | null;
  archetype: string | null;
  stack: number;
}

export interface RevealedHand {
  id: number;
  name: string;
  hole: Card[];
}

export interface DecisionSnapshot {
  street: string;
  board: Card[];
  potBefore: number;
  toCall: number;
  equity: number;
  win: number;
  tie: number;
  potOdds: number;
  rangeFraction: number;
  bluffShare: number;
  iterations: number;
  liveOpponents: number;
  evCall: number;
  evFold: number;
  evRaiseHint: number;
  chosen: string;
  chosenAmount: number;
  /** Hero's remaining stack (chips) before taking this action. */
  heroStack: number;
  /** Chips actually committed by this action (for risk / commitment analysis). */
  committed: number;
}

export interface HandHistoryEntry {
  handNumber: number;
  heroHole: Card[];
  board: Card[];
  actions: ActionRecord[];
  payouts: Payout[];
  heroDelta: number;
  revealed: RevealedHand[];
  decisions: DecisionSnapshot[];
  potTotal: number;
  seatNames: Record<number, string>;
  winners: number[];
  /** When the hero folded: how the folded hand would have fared at showdown. */
  foldOutcome?: FoldOutcome | null;
}

/** Per-opponent observed stats for the HUD (table-lifetime). */
export interface OpponentStat {
  id: number;
  hands: number;
  vpip: number;
  pfr: number;
  aggression: number;
  counters: {
    voluntary: number;
    pfr: number;
    aggressive: number;
    passive: number;
  };
}

export interface PersistedState {
  settings: Settings;
  stats: Stats;
  heroProfile: HeroProfile;
  history: HandHistoryEntry[];
}

export const DEFAULT_SETTINGS: Settings = {
  seatCount: 6,
  blindLevel: 1,
  startingStackBB: 100,
  chipRatio: 1,
  difficulty: 'medium',
  sound: true,
  mathEnabled: true,
  hudEnabled: false,
  fastMode: false,
};

export const DEFAULT_STATS: Stats = {
  handsPlayed: 0,
  netChips: 0,
  profitCurve: [],
  biggestPotWon: 0,
  showdownsWon: 0,
  showdownsSeen: 0,
  handsWon: 0,
};
