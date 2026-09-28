import { describe, it, expect } from 'vitest';
import {
  emptyHeroProfile,
  summarizePlayerHand,
  updateHeroProfile,
  type HandSummary,
} from './profile';
import { applyAction, startHand, type SeatInit } from '../engine/game';
import { parseCards } from '../engine/deck';
import type { GameConfig, GameState } from '../engine/gameTypes';

function baseSummary(partial: Partial<HandSummary>): HandSummary {
  return {
    heroId: 0,
    actions: [],
    facedSteal: false,
    heroFoldedToSteal: false,
    heroReachedShowdown: false,
    ...partial,
  };
}

describe('updateHeroProfile — new exploit dimensions', () => {
  it('tracks fold-to-cbet rate', () => {
    let p = emptyHeroProfile();
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: true }));
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: true }));
    p = updateHeroProfile(p, baseSummary({ facedCbet: true, heroFoldedToCbet: false }));
    expect(p.counters.cbetFaced).toBe(3);
    expect(p.counters.cbetFolded).toBe(2);
    // Bayesian prior prevents three observations from creating an extreme read.
    expect(p.foldToCbet).toBeCloseTo(0.5625, 5);
  });

  it('tracks river honesty split by bet size (bluffCaught)', () => {
    let p = emptyHeroProfile();
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: true, weak: true } }));
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: true, weak: false } }));
    p = updateHeroProfile(p, baseSummary({ riverBetShown: { big: false, weak: false } }));
    expect(p.counters.riverBetsShown).toBe(3);
    expect(p.counters.riverBigShown).toBe(2);
    expect(p.counters.riverBigWeak).toBe(1);
    expect(p.counters.riverSmallShown).toBe(1);
    expect(p.counters.riverSmallWeak).toBe(0);
    expect(p.bluffCaught).toBeCloseTo(0.3125, 5);
  });

  it('does not label a losing river value bet as a bluff', () => {
    const game = {
      players: [
        {
          id: 0,
          isHero: true,
          hole: parseCards('Ah Qd'),
          folded: false,
          sittingOut: false,
        },
        {
          id: 1,
          isHero: false,
          hole: parseCards('As Ks'),
          folded: false,
          sittingOut: false,
        },
      ],
      board: parseCards('Ac 8c 3d 6s 2h'),
      history: [
        {
          playerId: 0,
          street: 'river',
          type: 'bet',
          amount: 20,
          chipsPutIn: 20,
          raiseBy: 20,
          potBefore: 30,
          toCall: 0,
        },
      ],
      revealed: [0, 1],
      buttonIndex: 0,
      bigBlind: 2,
    } as GameState;

    expect(summarizePlayerHand(game, 0).riverBetShown).toEqual({
      big: true,
      weak: false,
    });
  });

  it('records a folded-to button open as a steal but not a limped-pot isolation', () => {
    const config: GameConfig = {
      seatCount: 6,
      blindLevel: 1,
      startingStackBB: 100,
      difficulty: 'hard',
    };
    const seats: SeatInit[] = Array.from({ length: 6 }, (_, id) => ({
      id,
      name: `P${id}`,
      isHero: id === 2,
      stack: 200,
    }));

    let unopened = startHand(config, seats, 0, 1, () => 0.42);
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'raise', amount: 6 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    unopened = applyAction(unopened, { type: 'fold', amount: 0 });
    expect(summarizePlayerHand(unopened, 2).facedSteal).toBe(true);

    let limped = startHand(config, seats, 0, 2, () => 0.42);
    limped = applyAction(limped, { type: 'call', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'raise', amount: 6 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    limped = applyAction(limped, { type: 'fold', amount: 0 });
    expect(summarizePlayerHand(limped, 2).facedSteal).toBe(false);
  });

  const action = (street: 'preflop' | 'flop' | 'turn' | 'river', playerId: number, type: 'check' | 'bet' | 'call' | 'raise' | 'allin' | 'fold', chips: number, potBefore: number, toCall: number) => ({
    playerId,
    street,
    type,
    amount: chips,
    chipsPutIn: chips,
    raiseBy: type === 'bet' || type === 'raise' || type === 'allin' ? chips - toCall : 0,
    potBefore,
    toCall,
  });

  it('counts opening-bet chances and opening bets by size, not bets into a bet', () => {
    const game = {
      players: [
        { id: 0, isHero: true, hole: parseCards('Ah Qd'), folded: false, sittingOut: false },
        { id: 1, isHero: false, hole: parseCards('As Ks'), folded: false, sittingOut: false },
      ],
      board: parseCards('Ac 8c 3d 6s 2h'),
      history: [
        action('preflop', 0, 'raise', 6, 3, 1),
        action('preflop', 1, 'call', 4, 9, 4),
        // Flop: the pre-flop raiser c-bets a quarter pot when checked to.
        action('flop', 1, 'check', 0, 12, 0),
        action('flop', 0, 'bet', 3, 12, 0),
        action('flop', 1, 'call', 3, 15, 3),
        // Turn: villain leads, hero only calls — no chance to open.
        action('turn', 1, 'bet', 9, 18, 0),
        action('turn', 0, 'call', 9, 27, 9),
        // River: checked to, hero overbets.
        action('river', 1, 'check', 0, 36, 0),
        action('river', 0, 'bet', 45, 36, 0),
      ],
      revealed: [],
      buttonIndex: 0,
      bigBlind: 2,
    } as unknown as GameState;

    const summary = summarizePlayerHand(game, 0);
    // Only the flop follows the hero's own aggression; the river follows the villain's lead.
    const none = { opportunities: 0, small: 0, medium: 0, big: 0, continuationChances: 0, continuationBets: 0 };
    expect(summary.openingBets).toEqual({
      flop: { ...none, opportunities: 1, small: 1, continuationChances: 1, continuationBets: 1 },
      turn: none,
      river: { ...none, opportunities: 1, big: 1 },
    });
    const p = updateHeroProfile(emptyHeroProfile(), summary);
    expect(p.counters.betOpportunities).toBe(2);
    expect(p.counters.smallBets).toBe(1);
    expect(p.counters.bigBets).toBe(1);
    expect(p.counters.continuationChances).toBe(1);
    expect(p.counters.flopBetChances).toBe(1);
    expect(p.counters.flopSmallBets).toBe(1);
    expect(p.counters.flopContinuationBets).toBe(1);
    expect(p.counters.turnBetChances).toBe(0);
    expect(p.counters.riverBetChances).toBe(1);
    expect(p.counters.riverBigBets).toBe(1);
    expect(p.counters.riverContinuationChances).toBe(0);
  });

  it('records folds to the opening river bet, not to a raise of its own bet', () => {
    const hand = (river: ReturnType<typeof action>[]) =>
      ({
        players: [
          { id: 0, isHero: true, hole: parseCards('Ah Qd'), folded: false, sittingOut: false },
          { id: 1, isHero: false, hole: parseCards('As Ks'), folded: false, sittingOut: false },
        ],
        board: parseCards('Ac 8c 3d 6s 2h'),
        history: [
          action('preflop', 0, 'raise', 6, 3, 1),
          action('preflop', 1, 'call', 4, 9, 4),
          action('flop', 1, 'check', 0, 12, 0),
          action('flop', 0, 'check', 0, 12, 0),
          action('turn', 1, 'check', 0, 12, 0),
          action('turn', 0, 'check', 0, 12, 0),
          ...river,
        ],
        revealed: [],
        buttonIndex: 0,
        bigBlind: 2,
      }) as unknown as GameState;

    const folded = hand([action('river', 1, 'bet', 8, 12, 0), action('river', 0, 'fold', 0, 20, 8)]);
    expect(summarizePlayerHand(folded, 0).riverBetFaced).toEqual({ folded: true });
    // The bettor itself faced nothing.
    expect(summarizePlayerHand(folded, 1).riverBetFaced).toBeNull();

    const checkRaised = hand([
      action('river', 1, 'check', 0, 12, 0),
      action('river', 0, 'bet', 8, 12, 0),
      action('river', 1, 'raise', 24, 20, 8),
      action('river', 0, 'fold', 0, 44, 16),
    ]);
    // Folding to a check-raise is the raises-faced read, not this one.
    expect(summarizePlayerHand(checkRaised, 0).riverBetFaced).toBeNull();

    const called = hand([
      action('river', 1, 'bet', 8, 12, 0),
      action('river', 0, 'call', 8, 20, 8),
    ]);
    let p = updateHeroProfile(emptyHeroProfile(), summarizePlayerHand(folded, 0));
    p = updateHeroProfile(p, summarizePlayerHand(called, 0));
    expect(p.counters.riverBetsFaced).toBe(2);
    expect(p.counters.riverBetFolds).toBe(1);
    expect(p.foldToRiverBet).toBeGreaterThan(0.45);
    expect(p.foldToRiverBet).toBeLessThan(0.5);
  });

  it('counts the raises met after betting and the folds to them', () => {
    const game = {
      players: [
        { id: 0, isHero: true, hole: parseCards('Ah Qd'), folded: true, sittingOut: false },
        { id: 1, isHero: false, hole: parseCards('As Ks'), folded: false, sittingOut: false },
      ],
      board: parseCards('Ac 8c 3d 6s 2h'),
      history: [
        action('preflop', 0, 'raise', 6, 3, 1),
        action('preflop', 1, 'call', 4, 9, 4),
        // Flop: the c-bet is check-raised and called.
        action('flop', 1, 'check', 0, 12, 0),
        action('flop', 0, 'bet', 6, 12, 0),
        action('flop', 1, 'raise', 18, 18, 6),
        action('flop', 0, 'call', 12, 36, 12),
        // Turn: the bet is only called.
        action('turn', 1, 'check', 0, 48, 0),
        action('turn', 0, 'bet', 24, 48, 0),
        action('turn', 1, 'call', 24, 72, 24),
        // River: the hero raises a lead, meets an all-in and folds.
        action('river', 1, 'bet', 30, 96, 0),
        action('river', 0, 'raise', 90, 126, 30),
        action('river', 1, 'allin', 150, 216, 60),
        action('river', 0, 'fold', 0, 366, 90),
      ],
      revealed: [],
      buttonIndex: 0,
      bigBlind: 2,
    } as unknown as GameState;

    const summary = summarizePlayerHand(game, 0);
    expect(summary.raisedAfterBetting).toEqual({ faced: 2, folded: 1 });
    // The villain's flop check-raise was never raised back; its river lead was, and it re-raised.
    expect(summarizePlayerHand(game, 1).raisedAfterBetting).toEqual({ faced: 1, folded: 0 });
    const p = updateHeroProfile(emptyHeroProfile(), summary);
    expect(p.counters.raisesFaced).toBe(2);
    expect(p.counters.raisesFolded).toBe(1);
  });
});
