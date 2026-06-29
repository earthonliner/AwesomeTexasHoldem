import type { Street, PlayerAction } from './types';
import { makeDeck, shuffle, type Rng, defaultRng } from './deck';
import { buildPots, distributePots, type PotContribution, type PlayerHand } from './sidePots';
import { evaluateHand } from './handEvaluator';
import {
  BB_CHIPS,
  SB_CHIPS,
  type GameConfig,
  type GameState,
  type PlayerState,
  type LegalActions,
  type ActionRecord,
} from './gameTypes';

export interface SeatInit {
  id: number;
  name: string;
  isHero: boolean;
  stack: number;
  /** Force this seat to sit out the hand (e.g. empty/disconnected seats). */
  sittingOut?: boolean;
}

/** Order of streets used when advancing the hand. */
const STREET_FLOW: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];

function clone(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p, hole: [...p.hole] })),
    deck: [...state.deck],
    board: [...state.board],
    pots: state.pots.map((p) => ({ ...p, eligible: [...p.eligible] })),
    payouts: state.payouts.map((p) => ({ ...p })),
    history: [...state.history],
    revealed: [...state.revealed],
  };
}

/** Players still contesting the pot (not folded, not sitting out). */
function livePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.folded && !p.sittingOut);
}

/** Players who can still make a betting decision. */
function actablePlayers(state: GameState): PlayerState[] {
  return livePlayers(state).filter((p) => !p.allIn);
}

function nextOccupiedIndex(state: GameState, from: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (!state.players[idx].sittingOut) return idx;
  }
  return from;
}

/**
 * Start a fresh hand: post blinds, deal hole cards and set the first actor.
 * Pure: returns a new GameState; the provided rng controls the shuffle.
 */
export function startHand(
  config: GameConfig,
  seats: SeatInit[],
  buttonIndex: number,
  handNumber: number,
  rng: Rng = defaultRng,
): GameState {
  const players: PlayerState[] = seats.map((s) => ({
    id: s.id,
    name: s.name,
    isHero: s.isHero,
    stack: s.stack,
    hole: [],
    folded: false,
    allIn: false,
    streetCommitted: 0,
    totalCommitted: 0,
    hasActed: false,
    lastAction: null,
    sittingOut: (s.sittingOut ?? false) || s.stack <= 0,
  }));

  const deck = shuffle(makeDeck(), rng);

  const base: GameState = {
    config,
    players,
    buttonIndex,
    smallBlind: SB_CHIPS,
    bigBlind: BB_CHIPS,
    deck,
    board: [],
    street: 'preflop',
    toAct: -1,
    currentBet: 0,
    minRaise: BB_CHIPS,
    pots: [],
    payouts: [],
    status: 'betting',
    history: [],
    handNumber,
    revealed: [],
  };

  const active = base.players.filter((p) => !p.sittingOut);
  const headsUp = active.length === 2;

  // Determine blind seats relative to the button.
  let sbIndex: number;
  let bbIndex: number;
  if (headsUp) {
    sbIndex = buttonIndex; // button posts SB heads-up
    bbIndex = nextOccupiedIndex(base, buttonIndex);
  } else {
    sbIndex = nextOccupiedIndex(base, buttonIndex);
    bbIndex = nextOccupiedIndex(base, sbIndex);
  }

  postBlind(base, sbIndex, SB_CHIPS);
  postBlind(base, bbIndex, BB_CHIPS);
  base.currentBet = BB_CHIPS;
  base.minRaise = BB_CHIPS;

  // Deal two hole cards to each occupied seat.
  let cursor = 0;
  for (let round = 0; round < 2; round++) {
    for (const p of base.players) {
      if (!p.sittingOut) p.hole.push(base.deck[cursor++]);
    }
  }
  base.deck = base.deck.slice(cursor);

  // First to act preflop: heads-up SB (button) acts first; otherwise UTG (BB+1).
  base.toAct = headsUp ? sbIndex : nextOccupiedIndex(base, bbIndex);
  // Blind posters have not "acted" yet (they get an option).
  return base;
}

function postBlind(state: GameState, index: number, amount: number): void {
  const p = state.players[index];
  const post = Math.min(amount, p.stack);
  p.stack -= post;
  p.streetCommitted += post;
  p.totalCommitted += post;
  if (p.stack === 0) p.allIn = true;
}

export function getLegalActions(state: GameState, playerIndex: number): LegalActions {
  const p = state.players[playerIndex];
  const toCall = state.currentBet - p.streetCommitted;
  const canCheck = toCall <= 0;
  const callAmount = Math.min(toCall, p.stack);

  // Max raise target = everything the player has on top of what they've committed.
  const maxRaiseTo = p.streetCommitted + p.stack;
  // Min raise target follows the last full raise increment, capped at all-in.
  const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo);

  const canAggress = p.stack > toCall; // has chips beyond a call to put in
  return {
    canFold: true,
    canCheck,
    canCall: !canCheck && p.stack > 0,
    callAmount,
    canBet: canCheck && canAggress,
    canRaise: !canCheck && canAggress,
    minRaiseTo,
    maxRaiseTo,
  };
}

/**
 * Apply a player's action and advance the hand. The `action.amount` for
 * bet/raise is the target streetCommitted level; for call/check/fold it's
 * ignored. Returns a new state.
 */
export function applyAction(state: GameState, action: PlayerAction): GameState {
  const next = clone(state);
  if (next.status !== 'betting' || next.toAct < 0) return next;

  const idx = next.toAct;
  const p = next.players[idx];
  const legal = getLegalActions(next, idx);
  const potBefore = totalPot(next);
  const toCall = next.currentBet - p.streetCommitted;

  const record: ActionRecord = {
    playerId: p.id,
    street: next.street,
    type: action.type,
    amount: 0,
    potBefore,
    toCall,
  };

  switch (action.type) {
    case 'fold': {
      p.folded = true;
      p.lastAction = 'fold';
      break;
    }
    case 'check': {
      p.lastAction = 'check';
      break;
    }
    case 'call': {
      const pay = Math.min(toCall, p.stack);
      commit(p, pay);
      p.lastAction = 'call';
      record.amount = pay;
      break;
    }
    case 'bet':
    case 'raise':
    case 'allin': {
      let target: number;
      if (action.type === 'allin') {
        target = legal.maxRaiseTo;
      } else {
        target = Math.min(Math.max(action.amount, legal.minRaiseTo), legal.maxRaiseTo);
      }
      const delta = target - p.streetCommitted;
      const increment = target - next.currentBet;
      commit(p, delta);

      // A raise reopens betting only if it is at least a full minimum raise.
      const isFullRaise = increment >= next.minRaise - 1e-9;
      if (isFullRaise) {
        next.minRaise = increment;
        for (const other of next.players) {
          if (!other.folded && !other.allIn && other.id !== p.id) other.hasActed = false;
        }
      }
      next.currentBet = Math.max(next.currentBet, target);
      // An action with nothing to call is an opening bet; otherwise a raise.
      p.lastAction = p.allIn ? 'allin' : toCall <= 0 ? 'bet' : 'raise';
      record.amount = target;
      break;
    }
  }

  p.hasActed = true;
  record.type = p.lastAction ?? action.type;
  next.history.push(record);

  advance(next);
  return next;
}

function commit(p: PlayerState, amount: number): void {
  const pay = Math.min(amount, p.stack);
  p.stack -= pay;
  p.streetCommitted += pay;
  p.totalCommitted += pay;
  if (p.stack === 0) p.allIn = true;
}

export function totalPot(state: GameState): number {
  return state.players.reduce((s, p) => s + p.totalCommitted, 0);
}

/** Advance the state: pick the next actor, change streets, or go to showdown. */
function advance(state: GameState): void {
  // Win by everyone folding.
  if (livePlayers(state).length <= 1) {
    finishHand(state);
    return;
  }

  const nextActor = findNextActor(state);
  if (nextActor >= 0) {
    state.toAct = nextActor;
    return;
  }

  // Betting round is settled. If at most one player can still act and others are
  // all-in, run out the remaining board, otherwise move to the next street.
  state.toAct = -1;
  if (state.street === 'river') {
    state.street = 'showdown';
    finishHand(state);
    return;
  }

  // If nobody can act anymore (all-in situation), deal all remaining streets.
  if (actablePlayers(state).length <= 1 && everyoneMatched(state)) {
    runoutToShowdown(state);
    return;
  }

  advanceStreet(state);
}

function everyoneMatched(state: GameState): boolean {
  return livePlayers(state)
    .filter((p) => !p.allIn)
    .every((p) => p.streetCommitted === state.currentBet);
}

/** Find the next player who still owes action this street, else -1. */
function findNextActor(state: GameState): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.toAct + step) % n;
    const p = state.players[idx];
    if (p.folded || p.allIn || p.sittingOut) continue;
    const owes = p.streetCommitted < state.currentBet;
    if (!p.hasActed || owes) return idx;
  }
  return -1;
}

function advanceStreet(state: GameState): void {
  const order = STREET_FLOW.indexOf(state.street);
  const nextStreet = STREET_FLOW[order + 1];
  state.street = nextStreet;

  // Reset per-street betting fields.
  state.currentBet = 0;
  state.minRaise = BB_CHIPS;
  for (const p of state.players) {
    p.streetCommitted = 0;
    p.hasActed = false;
    if (!p.folded && !p.allIn) p.lastAction = null;
  }

  dealStreetCards(state);

  // First to act post-flop: first live, actable player left of the button.
  const first = firstActorPostflop(state);
  state.toAct = first;

  // If nobody can act (all-in), continue running out.
  if (first < 0 || actablePlayers(state).length === 0) {
    if (state.street === 'river') {
      state.street = 'showdown';
      finishHand(state);
    } else {
      advanceStreet(state);
    }
  }
}

function firstActorPostflop(state: GameState): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.buttonIndex + step) % n;
    const p = state.players[idx];
    if (!p.folded && !p.allIn && !p.sittingOut) return idx;
  }
  return -1;
}

function dealStreetCards(state: GameState): void {
  if (state.street === 'flop') {
    state.board.push(state.deck[0], state.deck[1], state.deck[2]);
    state.deck = state.deck.slice(3);
  } else if (state.street === 'turn' || state.street === 'river') {
    state.board.push(state.deck[0]);
    state.deck = state.deck.slice(1);
  }
}

function runoutToShowdown(state: GameState): void {
  while (state.street !== 'river' && state.street !== 'showdown') {
    const order = STREET_FLOW.indexOf(state.street);
    state.street = STREET_FLOW[order + 1];
    dealStreetCards(state);
  }
  state.street = 'showdown';
  finishHand(state);
}

/** Resolve the hand: build pots, determine winners, pay out and bank stacks. */
function finishHand(state: GameState): void {
  state.toAct = -1;

  const contributions: PotContribution[] = state.players
    .filter((p) => p.totalCommitted > 0 || !p.sittingOut)
    .map((p) => ({ playerId: p.id, contributed: p.totalCommitted, folded: p.folded }));

  const pots = buildPots(contributions);
  state.pots = pots;

  const live = livePlayers(state);

  if (live.length === 1) {
    // Uncontested: the lone survivor takes everything, no cards revealed.
    const winner = live[0];
    const total = totalPot(state);
    winner.stack += total;
    state.payouts = [{ playerId: winner.id, amount: total }];
    state.status = 'complete';
    state.street = state.street === 'showdown' ? 'showdown' : state.street;
    return;
  }

  // Showdown: reveal live players and distribute by hand strength.
  state.revealed = live.map((p) => p.id);
  const hands: PlayerHand[] = live.map((p) => ({ playerId: p.id, holeCards: p.hole }));
  const seatOrderFromButton = orderFromButton(state);
  const payouts = distributePots(pots, hands, state.board, seatOrderFromButton);

  const byId = new Map(state.players.map((p) => [p.id, p]));
  for (const pay of payouts) {
    const p = byId.get(pay.playerId);
    if (p) p.stack += pay.amount;
  }
  state.payouts = payouts;
  state.status = 'complete';
  state.street = 'showdown';
}

/** Player ids ordered clockwise starting from the seat left of the button. */
function orderFromButton(state: GameState): number[] {
  const n = state.players.length;
  const order: number[] = [];
  for (let step = 1; step <= n; step++) {
    const idx = (state.buttonIndex + step) % n;
    if (!state.players[idx].sittingOut) order.push(state.players[idx].id);
  }
  return order;
}

/** Best made hand label for a player at showdown (UI helper). */
export function playerShowdownHand(state: GameState, playerId: number) {
  const p = state.players.find((x) => x.id === playerId);
  if (!p || p.hole.length < 2 || state.board.length < 3) return null;
  return evaluateHand([...p.hole, ...state.board]);
}

export function isHandOver(state: GameState): boolean {
  return state.status === 'complete';
}

/** Convenience for AI/tests: the player object whose turn it is, or null. */
export function actingPlayer(state: GameState): PlayerState | null {
  return state.toAct >= 0 ? state.players[state.toAct] : null;
}
