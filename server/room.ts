import { randomUUID } from 'node:crypto';
import {
  startHand,
  applyAction,
  getLegalActions,
  totalPot,
  type SeatInit,
} from '../src/engine/game';
import type { GameState, GameConfig } from '../src/engine/gameTypes';
import { BB_CHIPS } from '../src/engine/gameTypes';
import type { Card, PlayerAction } from '../src/engine/types';
import { generatePersonality } from '../src/ai/personality';
import { decide } from '../src/ai/decision';
import type { Personality, DecisionContext } from '../src/ai/types';
import { redactGameStateFor } from '../src/online/redact';
import {
  type ClientMsg,
  type RoomView,
  type SeatView,
  type SeatKind,
  type TableConfig,
  DEFAULT_TABLE_CONFIG,
} from '../src/online/protocol';

const AI_NAMES = ['Ava', 'Boris', 'Carmen', 'Dmitri', 'Elena', 'Frank', 'Gina', 'Hank'];
const TURN_MS = 30_000; // human decision time limit
const DISCONNECT_ACT_MS = 1_500; // grace before auto-acting for a disconnected human
const HAND_REVIEW_MS = 4_500; // pause between hands so everyone sees the result

interface ServerSeat {
  seatId: number;
  kind: SeatKind;
  name: string;
  stack: number;
  personality?: Personality;
  token?: string; // reclaim token for human seats
  clientId?: string; // attached connection
  connected: boolean;
  sittingOut: boolean; // not dealt into the next hand
}

export interface Connection {
  id: string;
  send: (data: string) => void;
}

/**
 * Authoritative single-table room. Holds the canonical game state, runs AI and
 * human turns with timers, and broadcasts a redacted view to each connection.
 */
export class Room {
  private config: TableConfig = { ...DEFAULT_TABLE_CONFIG };
  private seats: ServerSeat[] = [];
  private connections = new Map<string, Connection>();
  private pendingNames = new Map<string, string>();
  private hostId: string | null = null;

  private phase: 'lobby' | 'playing' = 'lobby';
  private game: GameState | null = null;
  private buttonSeatId = 0;
  private handOver = false;
  private lastResultText = '';
  private turnDeadline: number | null = null;

  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.rebuildSeats(this.config.seatCount);
  }

  // ---------- connection lifecycle ----------

  addConnection(conn: Connection): void {
    this.connections.set(conn.id, conn);
  }

  removeConnection(clientId: string): void {
    const seat = this.seats.find((s) => s.clientId === clientId);
    if (seat) {
      seat.connected = false;
      // During play keep the seat (allow reconnect); it will sit out next hand.
      if (this.phase === 'lobby') this.vacate(seat);
      else seat.sittingOut = true;
    }
    this.connections.delete(clientId);
    this.pendingNames.delete(clientId);
    if (this.hostId === clientId) this.reassignHost();
    this.broadcast();
  }

  private reassignHost(): void {
    const next = [...this.connections.keys()][0] ?? null;
    this.hostId = next;
  }

  private vacate(seat: ServerSeat): void {
    seat.kind = 'empty';
    seat.name = '';
    seat.token = undefined;
    seat.clientId = undefined;
    seat.connected = false;
    seat.sittingOut = false;
    seat.personality = undefined;
  }

  // ---------- message handling ----------

  handle(clientId: string, msg: ClientMsg): { youId: string; token: string } | void {
    switch (msg.t) {
      case 'hello':
        return this.onHello(clientId, msg.name, msg.token);
      case 'sit':
        this.onSit(clientId, msg.seatId);
        break;
      case 'stand':
        this.onStand(clientId);
        break;
      case 'config':
        if (clientId === this.hostId && this.phase === 'lobby') this.onConfig(msg.config);
        break;
      case 'addAI':
        if (clientId === this.hostId) this.onAddAI(msg.seatId);
        break;
      case 'removeAI':
        if (clientId === this.hostId) this.onRemoveAI(msg.seatId);
        break;
      case 'start':
        if (clientId === this.hostId && this.phase === 'lobby') this.startGame();
        break;
      case 'action':
        this.onAction(clientId, msg.action);
        break;
      case 'rebuy':
        this.onRebuy(clientId);
        break;
      case 'backToLobby':
        if (clientId === this.hostId) this.toLobby();
        break;
    }
    this.broadcast();
  }

  private onHello(clientId: string, name: string, token?: string): { youId: string; token: string } {
    if (!this.hostId) this.hostId = clientId;
    const safeName = (name || 'Player').slice(0, 16);
    this.pendingNames.set(clientId, safeName);

    // Reconnect: reclaim an existing seat by token.
    let reclaim = '';
    if (token) {
      const seat = this.seats.find((s) => s.token === token && s.kind === 'human');
      if (seat) {
        seat.clientId = clientId;
        seat.connected = true;
        seat.name = safeName;
        if (this.phase === 'playing') seat.sittingOut = false; // rejoin next hand
        reclaim = token;
      }
    }
    const finalToken = reclaim || randomUUID();
    this.broadcast();
    return { youId: clientId, token: finalToken };
  }

  private onSit(clientId: string, seatId: number): void {
    const seat = this.seats[seatId];
    if (!seat || seat.kind !== 'empty') return;
    // One seat per client.
    if (this.seats.some((s) => s.clientId === clientId)) return;
    seat.kind = 'human';
    seat.clientId = clientId;
    seat.connected = true;
    seat.token = randomUUID();
    seat.name = this.pendingNames.get(clientId) || 'Player';
    seat.stack = this.config.startingStackBB * BB_CHIPS;
    seat.sittingOut = this.phase === 'playing'; // join from the next hand
  }

  private onStand(clientId: string): void {
    const seat = this.seats.find((s) => s.clientId === clientId);
    if (seat) this.vacate(seat);
  }

  private onConfig(patch: Partial<TableConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.seatCount && patch.seatCount !== this.seats.length) {
      this.rebuildSeats(patch.seatCount);
    }
    if (patch.startingStackBB) {
      for (const s of this.seats) if (s.kind !== 'human') s.stack = patch.startingStackBB * BB_CHIPS;
    }
  }

  private rebuildSeats(count: number): void {
    const next: ServerSeat[] = [];
    for (let i = 0; i < count; i++) {
      next.push(
        this.seats[i] ?? {
          seatId: i,
          kind: 'empty',
          name: '',
          stack: 0,
          connected: false,
          sittingOut: false,
        },
      );
      next[i].seatId = i;
    }
    this.seats = next;
  }

  private onAddAI(seatId: number): void {
    const seat = this.seats[seatId];
    if (!seat || seat.kind !== 'empty') return;
    seat.kind = 'ai';
    seat.name = AI_NAMES[seatId % AI_NAMES.length];
    seat.personality = generatePersonality(this.config.difficulty, Math.random);
    seat.stack = this.config.startingStackBB * BB_CHIPS;
    seat.sittingOut = this.phase === 'playing';
  }

  private onRemoveAI(seatId: number): void {
    const seat = this.seats[seatId];
    if (seat && seat.kind === 'ai') this.vacate(seat);
  }

  // ---------- game flow ----------

  private activeSeats(): ServerSeat[] {
    return this.seats.filter((s) => s.kind !== 'empty' && !s.sittingOut && s.stack > 0);
  }

  private startGame(): void {
    if (this.activeSeats().length < 2) return;
    this.phase = 'playing';
    this.buttonSeatId = this.activeSeats()[0].seatId;
    this.startHand(true);
  }

  private toLobby(): void {
    this.clearTimers();
    this.phase = 'lobby';
    this.game = null;
    this.handOver = false;
    this.turnDeadline = null;
  }

  private startHand(first = false): void {
    this.clearTimers();

    // Refresh AI personalities only once (table lifetime); rebuy busted seats.
    for (const s of this.seats) {
      if (s.kind === 'ai' && s.stack <= 0) s.stack = this.config.startingStackBB * BB_CHIPS;
      // Reconnected humans rejoin; still-disconnected humans keep sitting out.
      if (s.kind === 'human' && !s.connected) s.sittingOut = true;
      else if (s.kind === 'human' && s.connected && s.stack > 0) s.sittingOut = false;
    }

    if (this.activeSeats().length < 2) {
      this.toLobby();
      return;
    }

    if (!first) this.buttonSeatId = this.nextActiveSeatId(this.buttonSeatId);

    const cfg: GameConfig = {
      seatCount: this.seats.length,
      blindLevel: this.config.blindLevel,
      startingStackBB: this.config.startingStackBB,
      difficulty: this.config.difficulty,
    };
    const seatInit: SeatInit[] = this.seats.map((s) => ({
      id: s.seatId,
      name: s.name || `Seat${s.seatId}`,
      isHero: false,
      stack: s.stack,
      sittingOut: s.kind === 'empty' || s.sittingOut || s.stack <= 0,
    }));

    this.game = startHand(cfg, seatInit, this.buttonSeatId, (this.game?.handNumber ?? 0) + 1, Math.random);
    this.handOver = false;
    this.lastResultText = '';
    this.advanceTurn();
  }

  private nextActiveSeatId(from: number): number {
    const n = this.seats.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + step) % n;
      const s = this.seats[idx];
      if (s.kind !== 'empty' && !s.sittingOut && s.stack > 0) return idx;
    }
    return from;
  }

  /** Decide what happens next: AI acts on a timer, humans get a deadline. */
  private advanceTurn(): void {
    this.clearActionTimer();
    const game = this.game;
    if (!game) return;

    if (game.status === 'complete') {
      this.finishHand();
      this.broadcast();
      return;
    }

    const idx = game.toAct;
    if (idx < 0) return;
    const seat = this.seats[idx];
    this.turnDeadline = null;

    if (seat.kind === 'ai') {
      this.scheduleAI(idx);
    } else if (!seat.connected) {
      // Disconnected human: auto check/fold shortly.
      this.actionTimer = setTimeout(() => this.autoAct(idx), DISCONNECT_ACT_MS);
    } else {
      this.turnDeadline = Date.now() + TURN_MS;
      this.actionTimer = setTimeout(() => this.autoAct(idx), TURN_MS);
    }
    this.broadcast();
  }

  private scheduleAI(idx: number): void {
    const game = this.game!;
    const seat = this.seats[idx];
    if (!seat.personality) return;
    const ctx = this.buildContext(game, idx);
    const decision = decide({
      personality: seat.personality,
      difficulty: this.config.difficulty,
      ctx,
      rng: Math.random,
    });
    const delay = Math.min(1600, Math.max(450, decision.thinkMs));
    this.actionTimer = setTimeout(() => {
      if (!this.game || this.game.toAct !== idx) return;
      this.apply({ type: decision.action, amount: decision.amount });
    }, delay);
  }

  private autoAct(idx: number): void {
    if (!this.game || this.game.toAct !== idx) return;
    const legal = getLegalActions(this.game, idx);
    this.apply(legal.canCheck ? { type: 'check', amount: 0 } : { type: 'fold', amount: 0 });
  }

  private onAction(clientId: string, action: PlayerAction): void {
    const game = this.game;
    if (!game || this.phase !== 'playing') return;
    const idx = game.toAct;
    if (idx < 0) return;
    const seat = this.seats[idx];
    if (seat.clientId !== clientId) return; // not your turn
    this.apply(action);
  }

  private apply(action: PlayerAction): void {
    if (!this.game) return;
    this.clearActionTimer();
    this.game = applyAction(this.game, action);
    this.syncStacks();
    this.advanceTurn();
  }

  private finishHand(): void {
    const game = this.game!;
    this.syncStacks();
    this.handOver = true;
    this.turnDeadline = null;
    this.lastResultText = this.buildResultText(game);

    const delay = HAND_REVIEW_MS;
    this.nextHandTimer = setTimeout(() => {
      if (this.phase === 'playing') this.startHand(false);
    }, delay);
  }

  private syncStacks(): void {
    if (!this.game) return;
    for (const p of this.game.players) {
      const seat = this.seats[p.id];
      if (seat) seat.stack = p.stack;
    }
  }

  private onRebuy(clientId: string): void {
    const seat = this.seats.find((s) => s.clientId === clientId);
    if (seat && seat.stack <= 0) {
      seat.stack = this.config.startingStackBB * BB_CHIPS;
      seat.sittingOut = false;
    }
  }

  private buildContext(game: GameState, idx: number): DecisionContext {
    const p = game.players[idx];
    const legal = getLegalActions(game, idx);
    const liveOpp = game.players.filter((x) => !x.folded && !x.sittingOut && x.id !== p.id).length;
    const n = game.players.length;
    const dist = (idx - game.buttonIndex + n) % n;
    return {
      hole: p.hole as [Card, Card],
      board: [...game.board],
      liveOpponents: Math.max(1, liveOpp),
      potBefore: totalPot(game),
      toCall: game.currentBet - p.streetCommitted,
      stack: p.stack,
      bigBlind: game.bigBlind,
      positionFactor: 1 - dist / n,
      street: game.street as DecisionContext['street'],
      canCheck: legal.canCheck,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
      streetCommitted: p.streetCommitted,
      recentImage: 0.3,
    };
  }

  private buildResultText(game: GameState): string {
    const winners = game.payouts.filter((p) => p.amount > 0);
    if (winners.length === 0) return '本手结束';
    const names = winners.map((w) => this.seats[w.playerId]?.name ?? `Seat${w.playerId}`);
    const total = winners.reduce((s, w) => s + w.amount, 0);
    return `${names.join('、')} 赢得底池 (${(total / BB_CHIPS).toFixed(1)} BB)`;
  }

  // ---------- broadcasting ----------

  private clearTimers(): void {
    this.clearActionTimer();
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.nextHandTimer = null;
  }

  private clearActionTimer(): void {
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
  }

  private seatViews(): SeatView[] {
    return this.seats.map((s) => ({
      seatId: s.seatId,
      kind: s.kind,
      name: s.name,
      connected: s.connected,
      stack: s.stack,
    }));
  }

  viewFor(clientId: string): RoomView {
    const seat = this.seats.find((s) => s.clientId === clientId);
    const youSeatId = seat?.seatId ?? null;
    const seatKinds: Record<number, SeatKind> = {};
    for (const s of this.seats) seatKinds[s.seatId] = s.kind;

    const base: RoomView = {
      phase: this.phase,
      config: this.config,
      hostId: this.hostId,
      youId: clientId,
      youSeatId,
      isHost: clientId === this.hostId,
      seats: this.seatViews(),
      seatKinds,
    };

    if (this.phase === 'playing' && this.game) {
      base.game = redactGameStateFor(this.game, youSeatId ?? -1);
      base.toActSeatId = this.game.toAct >= 0 ? this.game.toAct : null;
      base.turnDeadline = this.turnDeadline;
      base.handOver = this.handOver;
      base.lastResultText = this.lastResultText;
    }
    return base;
  }

  broadcast(): void {
    for (const [clientId, conn] of this.connections) {
      const view = this.viewFor(clientId);
      conn.send(JSON.stringify({ t: 'view', view }));
    }
  }
}
