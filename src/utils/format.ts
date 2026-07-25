import { BB_CHIPS } from '../engine/gameTypes';

/**
 * Money display. Internally the engine uses integer chips (SB = 1, BB = 2).
 * The chosen blind level (0.5 / 1 / 2 / 5) is a currency multiplier: with big
 * blind = 2, posting the big blind must SHOW as $2. All display helpers below
 * convert chips -> currency using the module-level display blind level.
 */
let displayBlindLevel = 1;

/** Set the blind level used for money display (call when settings change). */
export function setDisplayBlindLevel(level: number): void {
  if (Number.isFinite(level) && level > 0) displayBlindLevel = level;
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

/** Format a chip amount as display currency, e.g. "$25". */
export function formatBB(chips: number): string {
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

/** Currency value as a bare number string (no unit), for inline formulas. */
export function bbNum(chips: number, digits = 1): string {
  return fmtNum(chipsToMoney(chips), digits);
}

export function formatSigned(chips: number): string {
  const value = chipsToMoney(chips);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value))}`;
}
