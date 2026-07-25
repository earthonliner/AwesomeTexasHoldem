import { BB_CHIPS } from '../engine/gameTypes';

/**
 * Money display. Internally the engine uses integer chips (SB = 1, BB = 2).
 * The chosen blind level (0.5 / 1 / 2 / 5) is a currency multiplier: with big
 * blind = 2, posting the big blind must SHOW as $2. All display helpers below
 * convert chips -> currency using the module-level display blind level.
 */
let displayBlindLevel = 1;

/**
 * Physical chip ratio: how many table chips represent one big blind.
 * 1 -> amounts are shown directly as money ($). 10 or 20 -> amounts are shown
 * as chip counts (like a real home game where the big blind is posted with a
 * 10- or 20-chip, worth $1/$2 in cash).
 */
let displayChipRatio = 1;

/** Set the blind level used for money display (call when settings change). */
export function setDisplayBlindLevel(level: number): void {
  if (Number.isFinite(level) && level > 0) displayBlindLevel = level;
}

/** Set the chips-per-big-blind display ratio (1 = show money directly). */
export function setDisplayChipRatio(ratio: number): void {
  if (Number.isFinite(ratio) && ratio >= 1) displayChipRatio = ratio;
}

/** Convert internal chips (SB units) to a big-blind count. */
export function chipsToBB(chips: number): number {
  return chips / BB_CHIPS;
}

/** Convert internal chips to display currency (块) at the chosen blind level. */
export function chipsToMoney(chips: number): number {
  return chipsToBB(chips) * displayBlindLevel;
}

function fmtNum(value: number, digits = 1): string {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(digits);
}

/** Format an amount for display: money ("$25") or table chips ("250"). */
export function formatBB(chips: number): string {
  if (displayChipRatio > 1) return fmtNum(chipsToBB(chips) * displayChipRatio);
  return `$${fmtNum(chipsToMoney(chips))}`;
}

/** Format chips as a currency amount using an explicit blind level. */
export function formatCurrency(chips: number, blindLevel: number): string {
  const value = chipsToBB(chips) * blindLevel;
  const rounded = Math.round(value * 100) / 100;
  return `$${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatPercent(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** Display value as a bare number string (no unit), for inline formulas. */
export function bbNum(chips: number, digits = 1): string {
  if (displayChipRatio > 1) return fmtNum(chipsToBB(chips) * displayChipRatio, digits);
  return fmtNum(chipsToMoney(chips), digits);
}

export function formatSigned(chips: number): string {
  if (displayChipRatio > 1) {
    const v = chipsToBB(chips) * displayChipRatio;
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    return `${sign}${fmtNum(Math.abs(v))}`;
  }
  const value = chipsToMoney(chips);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value))}`;
}
