import { create } from 'zustand';
import type { Card } from '../engine/types';
import type { GameConfig, GameState, ActionRecord } from '../engine/gameTypes';
import { BB_CHIPS } from '../engine/gameTypes';
import { startHand as engineStartHand, applyAction, getLegalActions, totalPot, type SeatInit } from '../engine/game';
import { generatePersonality, describePersonality } from '../ai/personality';
import { decide } from '../ai/decision';
import { updateHeroProfile, emptyHeroProfile } from '../ai/profile';
import type { DecisionContext, HeroProfile } from '../ai/types';
import { computeHeroAnalysis, computeFoldOutcome, type HeroAnalysis } from '../utils/analysis';
import { sound, setMuted } from '../utils/sound';
import {
  type Settings,
  type Stats,
  type Seat,
  type HandHistoryEntry,
  type OpponentStat,
  type DecisionSnapshot,
  DEFAULT_STATS,
} from './types';
import { loadPersisted, savePersisted } from './persist';

const persisted = loadPersisted();
setMuted(!persisted.settings.sound);

let aiTimer: ReturnType<typeof setTimeout> | null = null;
let nextHandTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (aiTimer) clearTimeout(aiTimer);
  if (nextHandTimer) clearTimeout(nextHandTimer);
  aiTimer = null;
  nextHandTimer = null;
}

const HERO_NAMES = ['你 (Hero)'];
const AI_NAMES = ['Ava', 'Boris', 'Carmen', 'Dmitri', 'Elena', 'Frank', 'Gina', 'Hank'];

interface GameStore {
  settings: Settings;
  stats: Stats;
  heroProfile: HeroProfile;
  history: HandHistoryEntry[];
  opponentStats: Record<number, OpponentStat>;

  seats: Seat[];
  /** Table-lifetime net P/L per seat id (chips), excluding rebuys. */
  seatNet: Record<number, number>;
  buttonIndex: number;
  handNumber: number;
  game: GameState | null;
  analysis: HeroAnalysis | null;
  thinkingId: number | null;
  handOver: boolean;
  /** Hero decision snapshots accumulated during the live hand. */
  liveDecisions: DecisionSnapshot[];
  lastResultText: string;
  /** True when the hero folded during preflop: fast-forward and auto-advance. */
  heroFoldedPreflop: boolean;

  newTable: () => void;
  startNextHand: () => void;
  heroAct: (action: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin'; amount: number }) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetStats: () => void;
  rebuyHero: () => void;
}

function makeConfig(settings: Settings): GameConfig {
  return {
    seatCount: settings.seatCount,
    blindLevel: settings.blindLevel,
    startingStackBB: settings.startingStackBB,
    difficulty: settings.difficulty,
  };
}

function buildSeats(settings: Settings): Seat[] {
  const startStack = settings.startingStackBB * BB_CHIPS;
  const seats: Seat[] = [];
  seats.push({ id: 0, name: HERO_NAMES[0], isHero: true, personality: null, archetype: null, stack: startStack });
  for (let i = 1; i < settings.seatCount; i++) {
    const personality = generatePersonality(settings.difficulty, Math.random);
    seats.push({
      id: i,
      name: AI_NAMES[(i - 1) % AI_NAMES.length],
      isHero: false,
      personality,
      archetype: describePersonality(personality),
      stack: startStack,
    });
  }
  return seats;
}

function persistNow(s: GameStore): void {
  savePersisted({
    settings: s.settings,
    stats: s.stats,
    heroProfile: s.heroProfile,
    history: s.history,
  });
}

export const useGameStore = create<GameStore>((set, get) => ({
  settings: persisted.settings,
  stats: persisted.stats,
  heroProfile: persisted.heroProfile,
  history: persisted.history,
  opponentStats: {},

  seats: [],
  seatNet: {},
  buttonIndex: 0,
  handNumber: 0,
  game: null,
  analysis: null,
  thinkingId: null,
  handOver: false,
  liveDecisions: [],
  lastResultText: '',
  heroFoldedPreflop: false,

  newTable: () => {
    clearTimers();
    const { settings } = get();
    const seats = buildSeats(settings);
    set({
      seats,
      seatNet: {},
      buttonIndex: Math.floor(Math.random() * seats.length),
      handNumber: 0,
      opponentStats: {},
      game: null,
      handOver: false,
      lastResultText: '',
    });
    get().startNextHand();
  },

  startNextHand: () => {
    clearTimers();
    const state = get();
    const settings = state.settings;
    const startStack = settings.startingStackBB * BB_CHIPS;

    // Auto-rebuy AI seats that busted so the table stays full. Hero rebuys too,
    // keeping P/L accurate via per-hand deltas (rebuy is not counted as profit).
    const seats = state.seats.map((s) => ({ ...s, stack: s.stack <= 0 ? startStack : s.stack }));

    const handNumber = state.handNumber + 1;
    const buttonIndex = state.handNumber === 0 ? state.buttonIndex : nextOccupied(seats, state.buttonIndex);

    const seatInit: SeatInit[] = seats.map((s) => ({ id: s.id, name: s.name, isHero: s.isHero, stack: s.stack }));
    const game = engineStartHand(makeConfig(settings), seatInit, buttonIndex, handNumber, Math.random);

    if (settings.sound) sound.deal();

    set({
      seats,
      buttonIndex,
      handNumber,
      game,
      handOver: false,
      analysis: null,
      thinkingId: null,
      liveDecisions: [],
      lastResultText: '',
      heroFoldedPreflop: false,
    });
    tick(set, get);
  },

  heroAct: (action) => {
    const state = get();
    const game = state.game;
    if (!game || game.toAct < 0) return;
    const hi = game.players.findIndex((p) => p.isHero);
    if (game.toAct !== hi) return;

    // Snapshot the hero's decision point for the post-hand review.
    const analysis = state.analysis ?? computeHeroAnalysis(game, 800);
    if (analysis) {
      const heroPlayer = game.players[hi];
      const heroStack = heroPlayer.stack;
      // Chips this specific action risks (for commitment / risk-of-ruin review).
      let committed = 0;
      if (action.type === 'call') committed = Math.min(analysis.callAmount, heroStack);
      else if (action.type === 'raise' || action.type === 'allin')
        committed = Math.min(heroStack, Math.max(0, action.amount - heroPlayer.streetCommitted));

      const snap: DecisionSnapshot = {
        street: game.street,
        board: [...game.board],
        potBefore: analysis.potBefore,
        toCall: analysis.callAmount,
        equity: analysis.equity,
        win: analysis.win,
        tie: analysis.tie,
        potOdds: analysis.potOdds,
        rangeFraction: analysis.rangeFraction,
        bluffShare: analysis.bluffShare,
        iterations: analysis.iterations,
        liveOpponents: analysis.liveOpponents,
        evCall: analysis.callEV,
        evFold: 0,
        evRaiseHint: analysis.raiseEVHint,
        chosen: action.type,
        chosenAmount: action.amount,
        heroStack,
        committed,
      };
      set({ liveDecisions: [...state.liveDecisions, snap] });
    }

    // Folding preflop means there is nothing to review — flag it so the rest of
    // the hand resolves quickly and the next hand starts automatically.
    if (action.type === 'fold' && game.street === 'preflop') {
      set({ heroFoldedPreflop: true });
    }

    playActionSound(action.type, state.settings.sound);
    const next = applyAction(game, action);
    set({ game: next, analysis: null });
    tick(set, get);
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    setMuted(!settings.sound);
    set({ settings });
    persistNow({ ...get(), settings } as GameStore);
  },

  resetStats: () => {
    const stats = { ...DEFAULT_STATS, profitCurve: [] };
    const heroProfile = emptyHeroProfile();
    set({ stats, heroProfile, history: [] });
    persistNow({ ...get(), stats, heroProfile, history: [] } as GameStore);
  },

  rebuyHero: () => {
    const state = get();
    const startStack = state.settings.startingStackBB * BB_CHIPS;
    const seats = state.seats.map((s) => (s.isHero && s.stack <= 0 ? { ...s, stack: startStack } : s));
    set({ seats });
  },
}));

function nextOccupied(seats: Seat[], from: number): number {
  const n = seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (seats[idx].stack > 0) return idx;
  }
  return from;
}

type SetFn = (partial: Partial<GameStore>) => void;
type GetFn = () => GameStore;

/** Drive the turn loop: hero waits for input, AIs act on a timer. */
function tick(set: SetFn, get: GetFn): void {
  const state = get();
  const game = state.game;
  if (!game) return;

  if (game.status === 'complete') {
    finalize(set, get);
    return;
  }

  const idx = game.toAct;
  if (idx < 0) return;
  const player = game.players[idx];

  if (player.isHero) {
    const analysis = computeHeroAnalysis(game, 1200);
    set({ analysis, thinkingId: null });
    return;
  }

  scheduleAI(set, get, idx);
}

function scheduleAI(set: SetFn, get: GetFn, idx: number): void {
  const state = get();
  const game = state.game!;
  const seat = state.seats[idx];
  const player = game.players[idx];
  if (!seat.personality) return;

  const ctx = buildDecisionContext(game, idx);
  const decision = decide({
    personality: seat.personality,
    difficulty: state.settings.difficulty,
    ctx,
    rng: Math.random,
    heroProfile: state.heroProfile,
  });

  set({ thinkingId: player.id });

  // If the hero already folded preflop, resolve the rest of the hand snappily.
  const delay = state.heroFoldedPreflop
    ? 80
    : state.settings.fastMode
      ? Math.min(350, decision.thinkMs * 0.3)
      : decision.thinkMs;
  aiTimer = setTimeout(() => {
    const cur = get();
    if (!cur.game || cur.game.toAct !== idx) return;
    playActionSound(decision.action, cur.settings.sound);
    const next = applyAction(cur.game, { type: decision.action, amount: decision.amount });
    set({ game: next, thinkingId: null });
    tick(set, get);
  }, delay);
}

function buildDecisionContext(game: GameState, idx: number): DecisionContext {
  const p = game.players[idx];
  const legal = getLegalActions(game, idx);
  const liveOpponents = game.players.filter((x) => !x.folded && !x.sittingOut && x.id !== p.id).length;
  const n = game.players.length;
  // Position factor: distance from button (button ~ 1.0, earliest ~ 0).
  const distFromButton = (idx - game.buttonIndex + n) % n;
  const positionFactor = 1 - distFromButton / n;

  return {
    hole: p.hole as [Card, Card],
    board: [...game.board],
    liveOpponents: Math.max(1, liveOpponents),
    potBefore: totalPot(game),
    toCall: game.currentBet - p.streetCommitted,
    stack: p.stack,
    bigBlind: game.bigBlind,
    positionFactor,
    street: game.street as DecisionContext['street'],
    canCheck: legal.canCheck,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    streetCommitted: p.streetCommitted,
    recentImage: 0.3,
  };
}

function playActionSound(type: string, enabled: boolean): void {
  if (!enabled) return;
  switch (type) {
    case 'check':
      sound.check();
      break;
    case 'call':
      sound.call();
      break;
    case 'bet':
    case 'raise':
      sound.bet();
      break;
    case 'allin':
      sound.chips();
      break;
    case 'fold':
      sound.fold();
      break;
  }
}

/** Resolve a finished hand: stats, profile, HUD stats, history, then auto-advance. */
function finalize(set: SetFn, get: GetFn): void {
  const state = get();
  const game = state.game!;
  const hero = game.players.find((p) => p.isHero)!;

  // Hero net for this hand = stack change since the hand started.
  const heroStart = state.seats.find((s) => s.isHero)!.stack;
  const heroDelta = hero.stack - heroStart;

  // Accumulate table-lifetime net P/L per seat (delta vs the post-rebuy stack at
  // the start of this hand), so rebuys never count as winnings.
  const seatNet = { ...state.seatNet };
  for (const s of state.seats) {
    const gp = game.players.find((p) => p.id === s.id);
    if (gp) seatNet[s.id] = (seatNet[s.id] ?? 0) + (gp.stack - s.stack);
  }

  // Update seats from the resolved stacks.
  const seats = state.seats.map((s) => {
    const gp = game.players.find((p) => p.id === s.id)!;
    return { ...s, stack: gp.stack };
  });

  const potTotal = totalPot(game);
  const winners = game.payouts.filter((p) => p.amount > 0).map((p) => p.playerId);
  const heroWon = winners.includes(hero.id);

  const stats: Stats = {
    ...state.stats,
    handsPlayed: state.stats.handsPlayed + 1,
    netChips: state.stats.netChips + heroDelta,
    profitCurve: [...state.stats.profitCurve, state.stats.netChips + heroDelta],
    handsWon: state.stats.handsWon + (heroWon ? 1 : 0),
    biggestPotWon: heroWon ? Math.max(state.stats.biggestPotWon, potTotal) : state.stats.biggestPotWon,
    showdownsSeen: state.stats.showdownsSeen + (game.revealed.includes(hero.id) ? 1 : 0),
    showdownsWon: state.stats.showdownsWon + (game.revealed.includes(hero.id) && heroWon ? 1 : 0),
  };

  const heroProfile = updateHeroProfile(state.heroProfile, summarizeHeroHand(game, hero.id));
  const opponentStats = updateOpponentStats(state.opponentStats, game, hero.id);

  const revealed = game.revealed.map((id) => {
    const gp = game.players.find((p) => p.id === id)!;
    const seat = state.seats.find((s) => s.id === id)!;
    return { id, name: seat.name, hole: gp.hole };
  });

  // If the hero folded, analyse how the folded hand would have fared at showdown.
  const foldOutcome = hero.folded
    ? computeFoldOutcome({
        heroHole: hero.hole,
        board: game.board,
        deck: game.deck,
        opponents: game.players
          .filter((p) => !p.isHero && !p.sittingOut && p.hole.length === 2)
          .map((p) => ({ name: state.seats.find((s) => s.id === p.id)?.name ?? `Seat${p.id}`, hole: p.hole })),
      })
    : null;

  const entry: HandHistoryEntry = {
    handNumber: game.handNumber,
    heroHole: hero.hole,
    board: game.board,
    actions: game.history,
    payouts: game.payouts,
    heroDelta,
    revealed,
    decisions: state.liveDecisions,
    potTotal,
    seatNames: Object.fromEntries(state.seats.map((s) => [s.id, s.name])),
    winners,
    foldOutcome,
  };

  const resultText = buildResultText(game, hero.id, heroDelta);

  if (state.settings.sound) {
    if (heroDelta > 0) sound.win();
    else if (heroDelta < 0) sound.lose();
  }

  const history = [...state.history, entry];
  // Normally we stop on the final board so the player can review the hand (the
  // next hand starts only when they click "下一手"). Even after a preflop fold we
  // pause here so the player can study the final board and the folded-hand
  // outcome analysis; the remaining AI action was merely fast-forwarded.
  set({ seats, seatNet, stats, heroProfile, opponentStats, history, handOver: true, thinkingId: null, lastResultText: resultText });

  persistNow({ ...get(), stats, heroProfile, history } as GameStore);
}

function buildResultText(game: GameState, heroId: number, heroDelta: number): string {
  const winnerNames = game.payouts
    .filter((p) => p.amount > 0)
    .map((p) => game.players.find((x) => x.id === p.playerId)?.name ?? '?');
  const youWon = game.payouts.some((p) => p.playerId === heroId && p.amount > 0);
  if (youWon && heroDelta > 0) return `你赢得了底池 (+${(heroDelta / BB_CHIPS).toFixed(1)} BB)`;
  if (heroDelta < 0) return `${winnerNames.join('、')} 赢得底池 (${(heroDelta / BB_CHIPS).toFixed(1)} BB)`;
  return `本手结束`;
}

function summarizeHeroHand(game: GameState, heroId: number) {
  const actions = game.history;
  const heroPreflop = actions.filter((a) => a.playerId === heroId && a.street === 'preflop');
  const facedSteal = heroPreflop.some((a) => a.toCall > game.bigBlind);
  const heroFoldedToSteal = facedSteal && heroPreflop.some((a) => a.type === 'fold' && a.toCall > game.bigBlind);
  return {
    heroId,
    actions,
    facedSteal,
    heroFoldedToSteal,
    heroReachedShowdown: game.revealed.includes(heroId),
  };
}

function updateOpponentStats(
  prev: Record<number, OpponentStat>,
  game: GameState,
  heroId: number,
): Record<number, OpponentStat> {
  const next = { ...prev };
  const byPlayer = new Map<number, ActionRecord[]>();
  for (const a of game.history) {
    if (a.playerId === heroId) continue;
    const list = byPlayer.get(a.playerId) ?? [];
    list.push(a);
    byPlayer.set(a.playerId, list);
  }

  for (const p of game.players) {
    if (p.id === heroId || p.sittingOut) continue;
    const actions = byPlayer.get(p.id) ?? [];
    const cur =
      next[p.id] ??
      ({ id: p.id, hands: 0, vpip: 0, pfr: 0, aggression: 0, counters: { voluntary: 0, pfr: 0, aggressive: 0, passive: 0 } } as OpponentStat);
    const c = { ...cur.counters };

    let voluntary = false;
    let pfr = false;
    for (const a of actions) {
      if (a.street === 'preflop') {
        if ((a.type === 'call' && a.toCall > 0) || a.type === 'raise' || a.type === 'bet' || a.type === 'allin') voluntary = true;
        if (a.type === 'raise' || a.type === 'bet' || a.type === 'allin') pfr = true;
      }
      if (a.type === 'bet' || a.type === 'raise' || a.type === 'allin') c.aggressive += 1;
      if (a.type === 'call' || a.type === 'check') c.passive += 1;
    }
    if (voluntary) c.voluntary += 1;
    if (pfr) c.pfr += 1;

    const hands = cur.hands + 1;
    next[p.id] = {
      id: p.id,
      hands,
      vpip: c.voluntary / hands,
      pfr: c.pfr / hands,
      aggression: c.aggressive + c.passive > 0 ? c.aggressive / (c.aggressive + c.passive) : 0,
      counters: c,
    };
  }
  return next;
}
