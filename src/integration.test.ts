import { describe, it, expect } from 'vitest';
import { startHand, applyAction, getLegalActions, totalPot, type SeatInit } from './engine/game';
import type { GameConfig, GameState, Difficulty } from './engine/gameTypes';
import { BB_CHIPS } from './engine/gameTypes';
import { generatePersonality } from './ai/personality';
import { decide } from './ai/decision';
import type { Card } from './engine/types';
import type { DecisionContext, Personality } from './ai/types';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCtx(game: GameState, idx: number): DecisionContext {
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

function playHand(
  config: GameConfig,
  seats: SeatInit[],
  personalities: Personality[],
  button: number,
  difficulty: Difficulty,
  rng: () => number,
): GameState {
  let game = startHand(config, seats, button, 1, rng);
  let guard = 0;
  while (game.status === 'betting' && guard++ < 500) {
    const idx = game.toAct;
    if (idx < 0) break;
    const ctx = buildCtx(game, idx);
    const d = decide({ personality: personalities[idx], difficulty, ctx, rng, iterations: 80 });
    game = applyAction(game, { type: d.action, amount: d.amount });
  }
  expect(guard).toBeLessThan(500); // never loops forever
  expect(game.status).toBe('complete');
  return game;
}

describe('integration: full AI-driven sessions', () => {
  for (const seatCount of [2, 4, 6, 9]) {
    it(`plays a session of ${seatCount}-handed hands without leaking chips`, () => {
      const rng = seeded(seatCount * 13 + 1);
      const config: GameConfig = { seatCount, blindLevel: 1, startingStackBB: 100, difficulty: 'medium' };
      const personalities = Array.from({ length: seatCount }, (_, i) => generatePersonality('medium', seeded(i + 7)));

      let stacks = Array.from({ length: seatCount }, () => 100 * BB_CHIPS);
      let button = 0;

      for (let hand = 0; hand < 40; hand++) {
        // Rebuy any busted seats to keep the table full.
        stacks = stacks.map((s) => (s <= 0 ? 100 * BB_CHIPS : s));
        const totalBefore = stacks.reduce((a, b) => a + b, 0);

        const seats: SeatInit[] = stacks.map((stack, i) => ({ id: i, name: `P${i}`, isHero: i === 0, stack }));
        const game = playHand(config, seats, personalities, button, 'medium', rng);

        // Chip conservation within the hand.
        const totalAfter = game.players.reduce((a, p) => a + p.stack, 0);
        expect(totalAfter).toBe(totalBefore);

        // At least one winner received the pot.
        expect(game.payouts.reduce((a, p) => a + p.amount, 0)).toBe(totalPot(game));

        stacks = game.players.map((p) => p.stack);
        button = (button + 1) % seatCount;
      }
    });
  }

  it('handles hard difficulty with a hero profile without errors', () => {
    const rng = seeded(99);
    const config: GameConfig = { seatCount: 6, blindLevel: 1, startingStackBB: 100, difficulty: 'hard' };
    const personalities = Array.from({ length: 6 }, (_, i) => generatePersonality('hard', seeded(i + 3)));
    const seats: SeatInit[] = Array.from({ length: 6 }, (_, i) => ({ id: i, name: `P${i}`, isHero: i === 0, stack: 200 }));
    const game = playHand(config, seats, personalities, 0, 'hard', rng);
    expect(game.status).toBe('complete');
  });
});
