import type { Card, Street, ActionType } from './types';
import type { Payout, Pot } from './sidePots';

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * Money model: all chip values are integers in units of the small blind.
 * Internally SB = 1 chip and BB = 2 chips, so a 100 BB stack = 200 chips.
 * The chosen blind level (0.5 / 1 / 2 / 5) is a display-only currency multiplier.
 */
export const SB_CHIPS = 1;
export const BB_CHIPS = 2;

export interface GameConfig {
  /** Total seats at the table (hero + opponents), 2..9. */
  seatCount: number;
  /** Display value of the big blind: 0.5 / 1 / 2 / 5. */
  blindLevel: number;
  /** Starting stack measured in big blinds. */
  startingStackBB: number;
  difficulty: Difficulty;
}

export interface PlayerState {
  id: number;
  name: string;
  isHero: boolean;
  stack: number;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  /** Chips committed during the current betting round. */
  streetCommitted: number;
  /** Chips committed across the whole hand. */
  totalCommitted: number;
  /** Acted since the last aggressive action that reopened betting this street. */
  hasActed: boolean;
  lastAction: ActionType | null;
  sittingOut: boolean;
}

export interface ActionRecord {
  playerId: number;
  street: Street;
  type: ActionType;
  amount: number;
  /** Pot size before this action, for replay/analysis. */
  potBefore: number;
  toCall: number;
}

export type HandStatus = 'betting' | 'showdown' | 'complete';

export interface GameState {
  config: GameConfig;
  players: PlayerState[];
  buttonIndex: number;
  smallBlind: number;
  bigBlind: number;
  deck: Card[];
  board: Card[];
  street: Street;
  /** Index of the player to act, or -1 when the betting round is settled. */
  toAct: number;
  /** Highest streetCommitted this round (the level to call up to). */
  currentBet: number;
  /** Minimum legal raise increment over currentBet. */
  minRaise: number;
  pots: Pot[];
  payouts: Payout[];
  status: HandStatus;
  history: ActionRecord[];
  handNumber: number;
  /** Players who reached showdown with revealed cards (for UI). */
  revealed: number[];
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** Minimum total streetCommitted target for a bet/raise. */
  minRaiseTo: number;
  /** Maximum total streetCommitted target (all-in). */
  maxRaiseTo: number;
}
