import type { GameState, Difficulty } from '../engine/gameTypes';
import type { PlayerAction } from '../engine/types';

/** Wire protocol shared by the LAN server and the browser client. */

export interface TableConfig {
  seatCount: number;
  blindLevel: number;
  startingStackBB: number;
  /** Chips-per-big-blind display ratio (1 = show $, 10/20 = show chips). Shared
   * by the whole table so every player sees identical amounts. */
  chipRatio: number;
  difficulty: Difficulty;
}

export type SeatKind = 'empty' | 'human' | 'ai';

export interface SeatView {
  seatId: number;
  kind: SeatKind;
  name: string;
  connected: boolean;
  stack: number;
  /** Table-lifetime net profit/loss (chips), excluding rebuys. */
  net: number;
  /** A top-up was requested mid-hand and will apply next hand. */
  pendingTopUp: boolean;
}

export interface RoomView {
  phase: 'lobby' | 'playing';
  config: TableConfig;
  hostId: string | null;
  youId: string;
  youSeatId: number | null;
  isHost: boolean;
  seats: SeatView[];
  /** Redacted engine state (your hole cards only; deck stripped). Playing only. */
  game?: GameState;
  toActSeatId?: number | null;
  /** Epoch ms by which the current human must act, for a client-side countdown. */
  turnDeadline?: number | null;
  handOver?: boolean;
  lastResultText?: string;
  /** Map of seatId -> kind, so the client can label AI/human/empty during play. */
  seatKinds?: Record<number, SeatKind>;
  /** Seat ids of human players who have clicked "下一手" during the pause. */
  readySeatIds?: number[];
  message?: string;
}

// ---- Client -> Server ----
export type ClientMsg =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'sit'; seatId: number }
  | { t: 'stand' }
  | { t: 'config'; config: Partial<TableConfig> }
  | { t: 'addAI'; seatId: number }
  | { t: 'removeAI'; seatId: number }
  | { t: 'start' }
  | { t: 'action'; action: PlayerAction }
  | { t: 'rebuy' }
  | { t: 'ready' }
  | { t: 'backToLobby' };

// ---- Server -> Client ----
export type ServerMsg =
  | { t: 'welcome'; youId: string; token: string }
  | { t: 'view'; view: RoomView }
  | { t: 'error'; message: string };

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  seatCount: 6,
  blindLevel: 1,
  startingStackBB: 100,
  chipRatio: 1,
  difficulty: 'medium',
};

export const WS_PATH = '/ws';
