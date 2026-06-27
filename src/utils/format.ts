import { BB_CHIPS } from '../engine/gameTypes';

/** Convert internal chips (SB units) to a big-blind count. */
export function chipsToBB(chips: number): number {
  return chips / BB_CHIPS;
}

/** Format a chip amount as big blinds, e.g. "12.5 BB". */
export function formatBB(chips: number): string {
  const bb = chipsToBB(chips);
  const rounded = Math.round(bb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} BB`;
}

/** Format chips as a currency amount using the chosen blind level. */
export function formatCurrency(chips: number, blindLevel: number): string {
  const value = chipsToBB(chips) * blindLevel;
  const rounded = Math.round(value * 100) / 100;
  return `$${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatPercent(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** Big-blind value as a bare number string (no unit), for inline formulas. */
export function bbNum(chips: number, digits = 1): string {
  const bb = chipsToBB(chips);
  const rounded = Math.round(bb * 10 ** digits) / 10 ** digits;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(digits);
}

export function formatSigned(chips: number): string {
  const bb = Math.round(chipsToBB(chips) * 10) / 10;
  const sign = bb > 0 ? '+' : '';
  return `${sign}${Number.isInteger(bb) ? bb.toFixed(0) : bb.toFixed(1)} BB`;
}
