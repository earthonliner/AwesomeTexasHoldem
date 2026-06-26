import type { Personality, DecisionContext } from './types';
import { boardWetness } from './boardTexture';

/**
 * Compute a situational bluff frequency from the player's baseline bluff stat
 * and the live game state. Required by the spec: bluffing must react to
 * position, pot size, board wetness, opponent count and the player's own image.
 */
export function dynamicBluffFrequency(p: Personality, ctx: DecisionContext): number {
  let freq = p.bluff;

  // Position: late position bluffs are more profitable (fewer players behind).
  freq += p.positionAwareness * (ctx.positionFactor - 0.5) * 0.4;

  // Board wetness: more draws available -> more credible representation.
  freq += boardWetness(ctx.board) * 0.25;

  // Opponent count: bluffing into a crowd rarely works.
  const oppPenalty = Math.max(0, ctx.liveOpponents - 1) * 0.12;
  freq -= oppPenalty;

  // Pot size relative to stack: bluff more when it is cheap to apply pressure.
  const potToStack = ctx.stack > 0 ? ctx.potBefore / ctx.stack : 1;
  freq += (0.5 - Math.min(1, potToStack)) * 0.15 * p.potReactivity;

  // Self image: if recent play looks very aggressive, bluffs get called more.
  freq -= ctx.recentImage * 0.2;

  // Earlier streets give more room to barrel; river bluffs are committal.
  if (ctx.street === 'river') freq *= 0.85;

  return Math.min(0.8, Math.max(0, freq));
}
