// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { applyAction, startHand } from '../engine/game';
import type { GameConfig, GameState } from '../engine/gameTypes';
import { formatBB } from '../utils/format';
import { ActionBar } from './ActionBar';

afterEach(cleanup);

/** Three-handed: the hero on the button raises to 20 chips, both blinds call and check the flop to it. */
function heroCheckedToOnFlop(): GameState {
  const config: GameConfig = { seatCount: 3, blindLevel: 1, startingStackBB: 100, difficulty: 'hard' };
  const seats = [0, 1, 2].map((id) => ({ id, name: `P${id}`, isHero: id === 0, stack: 200 }));
  let game = startHand(config, seats, 0, 1, () => 0.5);
  game = applyAction(game, { type: 'raise', amount: 20 });
  game = applyAction(game, { type: 'call', amount: 0 });
  game = applyAction(game, { type: 'call', amount: 0 });
  game = applyAction(game, { type: 'check', amount: 0 });
  game = applyAction(game, { type: 'check', amount: 0 });
  return game;
}

describe('ActionBar pot-fraction buttons', () => {
  it('sizes a bet at a quarter and a third of the pot', () => {
    const game = heroCheckedToOnFlop();
    expect(game.street).toBe('flop');
    expect(game.toAct).toBe(0);
    const onAct = vi.fn();
    render(<ActionBar game={game} onAct={onAct} />);

    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels.slice(0, 4)).toEqual(['1/4 池', '1/3 池', '1/2 池', '3/4 池']);

    const betLabel = (chips: number) =>
      new RegExp(`下注 ${formatBB(chips).replace(/[$.]/g, '\\$&')}`);
    fireEvent.click(screen.getByText('1/4 池'));
    expect(screen.getByText(betLabel(15))).toBeTruthy();
    fireEvent.click(screen.getByText('1/3 池'));
    expect(screen.getByText(betLabel(20))).toBeTruthy();

    fireEvent.click(screen.getByText(/下注/));
    expect(onAct).toHaveBeenCalledWith({ type: 'raise', amount: 20 });
  });
});
