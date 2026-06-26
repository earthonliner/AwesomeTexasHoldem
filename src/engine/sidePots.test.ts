import { describe, it, expect } from 'vitest';
import { buildPots, distributePots, type PotContribution } from './sidePots';
import { parseCards } from './deck';

describe('buildPots', () => {
  it('makes a single pot when all contributions are equal', () => {
    const c: PotContribution[] = [
      { playerId: 0, contributed: 100, folded: false },
      { playerId: 1, contributed: 100, folded: false },
      { playerId: 2, contributed: 100, folded: false },
    ];
    const pots = buildPots(c);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible.sort()).toEqual([0, 1, 2]);
  });

  it('creates main + side pot with one short all-in', () => {
    // P0 all-in 50, P1 and P2 put in 200 each.
    const c: PotContribution[] = [
      { playerId: 0, contributed: 50, folded: false },
      { playerId: 1, contributed: 200, folded: false },
      { playerId: 2, contributed: 200, folded: false },
    ];
    const pots = buildPots(c);
    // Main pot: 50*3 = 150 (all eligible). Side: 150*2 = 300 (P1,P2).
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligible.sort()).toEqual([0, 1, 2]);
    expect(pots[1].amount).toBe(300);
    expect(pots[1].eligible.sort()).toEqual([1, 2]);
  });

  it('handles multiple all-in tiers', () => {
    const c: PotContribution[] = [
      { playerId: 0, contributed: 25, folded: false },
      { playerId: 1, contributed: 50, folded: false },
      { playerId: 2, contributed: 100, folded: false },
      { playerId: 3, contributed: 100, folded: false },
    ];
    const pots = buildPots(c);
    // Tier 25: 4*25=100 eligible {0,1,2,3}
    // Tier 50: 3*25=75  eligible {1,2,3}
    // Tier 100: 2*50=100 eligible {2,3}
    expect(pots.map((p) => p.amount)).toEqual([100, 75, 100]);
    expect(pots[0].eligible.sort()).toEqual([0, 1, 2, 3]);
    expect(pots[1].eligible.sort()).toEqual([1, 2, 3]);
    expect(pots[2].eligible.sort()).toEqual([2, 3]);
  });

  it('keeps folded dead money in the pot but not eligible', () => {
    const c: PotContribution[] = [
      { playerId: 0, contributed: 100, folded: true },
      { playerId: 1, contributed: 100, folded: false },
      { playerId: 2, contributed: 100, folded: false },
    ];
    const pots = buildPots(c);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible.sort()).toEqual([1, 2]);
  });

  it('total chips are always conserved', () => {
    const c: PotContribution[] = [
      { playerId: 0, contributed: 33, folded: false },
      { playerId: 1, contributed: 77, folded: true },
      { playerId: 2, contributed: 120, folded: false },
      { playerId: 3, contributed: 5, folded: false },
    ];
    const total = c.reduce((s, x) => s + x.contributed, 0);
    const pots = buildPots(c);
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(total);
  });
});

describe('distributePots', () => {
  const order = [1, 2, 3, 0]; // left of button first

  it('awards the whole pot to the best hand', () => {
    const pots = buildPots([
      { playerId: 0, contributed: 100, folded: false },
      { playerId: 1, contributed: 100, folded: false },
    ]);
    const board = parseCards('2c 7d 9h Th Kc');
    const payouts = distributePots(
      pots,
      [
        { playerId: 0, holeCards: parseCards('Ah As') },
        { playerId: 1, holeCards: parseCards('3h 4d') },
      ],
      board,
      order,
    );
    const p0 = payouts.find((p) => p.playerId === 0)!;
    expect(p0.amount).toBe(200);
  });

  it('splits a tied pot evenly', () => {
    const pots = buildPots([
      { playerId: 0, contributed: 100, folded: false },
      { playerId: 1, contributed: 100, folded: false },
    ]);
    const board = parseCards('Ac Ad Ah Kc Kd'); // both play the board to a full house
    const payouts = distributePots(
      pots,
      [
        { playerId: 0, holeCards: parseCards('2s 3s') },
        { playerId: 1, holeCards: parseCards('4s 5s') },
      ],
      board,
      order,
    );
    expect(payouts.find((p) => p.playerId === 0)!.amount).toBe(100);
    expect(payouts.find((p) => p.playerId === 1)!.amount).toBe(100);
  });

  it('splits main and side pots between the correct winners', () => {
    // P0 is all-in for 50; P1 and P2 each invest 100.
    const pots = buildPots([
      { playerId: 0, contributed: 50, folded: false },
      { playerId: 1, contributed: 100, folded: false },
      { playerId: 2, contributed: 100, folded: false },
    ]);
    // Main pot 150 (all eligible), side pot 100 (P1,P2 only).
    expect(pots[0].amount).toBe(150);
    expect(pots[1].amount).toBe(100);

    const board = parseCards('2c 7d 9h Th Kc');
    const payouts = distributePots(
      pots,
      [
        { playerId: 0, holeCards: parseCards('3h 4d') }, // king-high, loses
        { playerId: 1, holeCards: parseCards('As Ad') }, // pair of aces, wins both
        { playerId: 2, holeCards: parseCards('Qs Qd') }, // pair of queens
      ],
      board,
      [1, 2, 0],
    );
    expect(payouts.find((p) => p.playerId === 1)!.amount).toBe(250);
    expect(payouts.find((p) => p.playerId === 0)?.amount ?? 0).toBe(0);
    expect(payouts.find((p) => p.playerId === 2)?.amount ?? 0).toBe(0);
  });

  it('odd chip in a split pot goes to first eligible in button order', () => {
    // P2 folds 5 dead chips -> pot becomes an odd 25 shared by two tied winners.
    const pots = buildPots([
      { playerId: 0, contributed: 10, folded: false },
      { playerId: 1, contributed: 10, folded: false },
      { playerId: 2, contributed: 5, folded: true },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(25);

    const board = parseCards('Ac Ad Ah Kc Kd');
    const order = [1, 0]; // player 1 is left of button -> gets the odd chip
    const payouts = distributePots(
      pots,
      [
        { playerId: 0, holeCards: parseCards('7s 8s') },
        { playerId: 1, holeCards: parseCards('9s Ts') },
      ],
      board,
      order,
    );
    expect(payouts.reduce((s, p) => s + p.amount, 0)).toBe(25);
    expect(payouts.find((p) => p.playerId === 1)!.amount).toBe(13);
    expect(payouts.find((p) => p.playerId === 0)!.amount).toBe(12);
  });
});
