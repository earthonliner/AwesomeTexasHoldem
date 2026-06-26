import type { Rng } from '../engine/deck';
import { defaultRng } from '../engine/deck';
import type { Difficulty } from '../engine/gameTypes';
import type { Personality } from './types';

/** Draw a value around `mean` within +/- `spread`, clamped to [min,max]. */
function around(rng: Rng, mean: number, spread: number, min = 0, max = 1): number {
  const v = mean + (rng() * 2 - 1) * spread;
  return Math.min(max, Math.max(min, v));
}

/**
 * Generate a personality vector tuned by difficulty.
 *
 * - easy: extreme, readable archetypes (very tight/passive or very loose/wild),
 *   little bluffing and no position awareness.
 * - medium: balanced, believable distributions with situational play.
 * - hard: balanced-aggressive baseline; exploitative adjustments happen later in
 *   the decision layer using the hero profile.
 */
export function generatePersonality(difficulty: Difficulty, rng: Rng = defaultRng): Personality {
  if (difficulty === 'easy') {
    // Pick one of a few extreme archetypes so the player can read them quickly.
    const archetype = Math.floor(rng() * 3);
    switch (archetype) {
      case 0: // Rock: very tight & passive
        return {
          vpip: around(rng, 0.14, 0.04),
          pfr: around(rng, 0.3, 0.1),
          aggression: around(rng, 0.2, 0.08),
          bluff: around(rng, 0.03, 0.02),
          callDown: around(rng, 0.3, 0.1),
          positionAwareness: 0,
          stackReactivity: around(rng, 0.2, 0.1),
          potReactivity: around(rng, 0.2, 0.1),
        };
      case 1: // Calling station: loose & passive
        return {
          vpip: around(rng, 0.6, 0.08),
          pfr: around(rng, 0.1, 0.05),
          aggression: around(rng, 0.2, 0.08),
          bluff: around(rng, 0.05, 0.03),
          callDown: around(rng, 0.85, 0.1),
          positionAwareness: 0,
          stackReactivity: around(rng, 0.2, 0.1),
          potReactivity: around(rng, 0.2, 0.1),
        };
      default: // Maniac: loose & aggressive
        return {
          vpip: around(rng, 0.7, 0.08),
          pfr: around(rng, 0.7, 0.1),
          aggression: around(rng, 0.85, 0.1),
          bluff: around(rng, 0.2, 0.06),
          callDown: around(rng, 0.5, 0.1),
          positionAwareness: 0,
          stackReactivity: around(rng, 0.2, 0.1),
          potReactivity: around(rng, 0.2, 0.1),
        };
    }
  }

  if (difficulty === 'medium') {
    return {
      vpip: around(rng, 0.32, 0.1),
      pfr: around(rng, 0.55, 0.15),
      aggression: around(rng, 0.55, 0.15),
      bluff: around(rng, 0.22, 0.08),
      callDown: around(rng, 0.5, 0.15),
      positionAwareness: around(rng, 0.6, 0.2),
      stackReactivity: around(rng, 0.5, 0.2),
      potReactivity: around(rng, 0.5, 0.2),
    };
  }

  // hard: solid balanced-aggressive baseline.
  return {
    vpip: around(rng, 0.27, 0.06),
    pfr: around(rng, 0.7, 0.1),
    aggression: around(rng, 0.65, 0.12),
    bluff: around(rng, 0.3, 0.08),
    callDown: around(rng, 0.55, 0.12),
    positionAwareness: around(rng, 0.85, 0.1),
    stackReactivity: around(rng, 0.75, 0.12),
    potReactivity: around(rng, 0.75, 0.12),
  };
}

const ARCHETYPE_LABELS: Array<{ test: (p: Personality) => boolean; label: string }> = [
  { test: (p) => p.vpip < 0.2 && p.aggression < 0.4, label: '岩石/紧弱' },
  { test: (p) => p.vpip > 0.5 && p.aggression < 0.4, label: '跟注站/松弱' },
  { test: (p) => p.vpip > 0.5 && p.aggression > 0.6, label: '疯子/松凶' },
  { test: (p) => p.vpip < 0.35 && p.aggression > 0.6, label: '紧凶/TAG' },
];

/** Human-readable archetype guess (used only in dev/debug overlays). */
export function describePersonality(p: Personality): string {
  return ARCHETYPE_LABELS.find((a) => a.test(p))?.label ?? '均衡型';
}
