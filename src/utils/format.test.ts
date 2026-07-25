import { describe, it, expect, afterEach } from 'vitest';
import { formatBB, formatSigned, setDisplayBlindLevel, setDisplayChipRatio, chipsToMoney } from './format';
import { BB_CHIPS, SB_CHIPS } from '../engine/gameTypes';

afterEach(() => {
  setDisplayBlindLevel(1);
  setDisplayChipRatio(1);
});

describe('money display follows the chosen blind level', () => {
  it('big blind level 2: the big blind posts as $2 and the small blind as $1', () => {
    setDisplayBlindLevel(2);
    expect(formatBB(BB_CHIPS)).toBe('$2');
    expect(formatBB(SB_CHIPS)).toBe('$1');
  });

  it('big blind level 0.5: the big blind posts as $0.5', () => {
    setDisplayBlindLevel(0.5);
    expect(formatBB(BB_CHIPS)).toBe('$0.5');
  });

  it('default level 1: a 100 BB stack shows as $100', () => {
    expect(formatBB(100 * BB_CHIPS)).toBe('$100');
  });

  it('level 5: a 100 BB stack shows as $500 and losses are signed', () => {
    setDisplayBlindLevel(5);
    expect(formatBB(100 * BB_CHIPS)).toBe('$500');
    expect(formatSigned(-BB_CHIPS)).toBe('-$5');
    expect(formatSigned(BB_CHIPS)).toBe('+$5');
  });

  it('chipsToMoney converts chips through the level', () => {
    setDisplayBlindLevel(2);
    expect(chipsToMoney(3)).toBe(3); // 1.5 BB × 2
  });
});

describe('physical chip ratio display (10:1 / 20:1)', () => {
  it('10:1 — the big blind posts as 10 chips, small blind as 5', () => {
    setDisplayChipRatio(10);
    expect(formatBB(BB_CHIPS)).toBe('10');
    expect(formatBB(SB_CHIPS)).toBe('5');
  });

  it('20:1 — the big blind posts as 20 chips, a 100BB stack as 2000', () => {
    setDisplayChipRatio(20);
    expect(formatBB(BB_CHIPS)).toBe('20');
    expect(formatBB(100 * BB_CHIPS)).toBe('2000');
    expect(formatSigned(-5 * BB_CHIPS)).toBe('-100');
  });

  it('chip display is independent of the blind level (money stays implicit)', () => {
    setDisplayBlindLevel(2); // BB worth $2
    setDisplayChipRatio(10); // posted with a 10-chip
    expect(formatBB(BB_CHIPS)).toBe('10');
  });

  it('ratio 1 restores money display', () => {
    setDisplayChipRatio(10);
    setDisplayChipRatio(1);
    expect(formatBB(BB_CHIPS)).toBe('$1');
  });
});
