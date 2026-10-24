/**
 * A stand-in for an observant human: the hard AI's own strategy that keeps a
 * profile of every opponent and reads whichever one drives the hand, the way
 * a player using the odds panel adjusts to each AI's habits.
 *
 * By default the reader plays the AI code of this checkout, so it improves
 * with the AI. `READER_FROM=/path/to/checkout` plays it with the code of
 * another checkout instead (e.g. `git archive main src | tar -x -C /tmp/base`),
 * which keeps the stand-in human the same while the AI changes.
 */
import { pathToFileURL } from 'node:url';
import type { GameState } from '../../src/engine/gameTypes';
import * as liveContext from '../../src/ai/context';
import * as liveDecision from '../../src/ai/decision';
import * as liveLine from '../../src/ai/line';
import * as liveProfile from '../../src/ai/profile';
import type { ContextMeta } from '../../src/ai/context';
import type { AIDecision, HeroProfile, Personality } from '../../src/ai/types';

interface ReaderCode {
  buildDecisionContext: typeof liveContext.buildDecisionContext;
  decide: typeof liveDecision.decide;
  deriveLineContext: typeof liveLine.deriveLineContext;
  emptyHeroProfile: typeof liveProfile.emptyHeroProfile;
  summarizePlayerHand: typeof liveProfile.summarizePlayerHand;
  updateHeroProfile: typeof liveProfile.updateHeroProfile;
}

let code: ReaderCode = {
  buildDecisionContext: liveContext.buildDecisionContext,
  decide: liveDecision.decide,
  deriveLineContext: liveLine.deriveLineContext,
  emptyHeroProfile: liveProfile.emptyHeroProfile,
  summarizePlayerHand: liveProfile.summarizePlayerHand,
  updateHeroProfile: liveProfile.updateHeroProfile,
};

/** Load the reader's strategy and profiling from another checkout's `src/ai`. */
export async function useReaderFrom(root: string | undefined): Promise<void> {
  if (!root) return;
  const load = (name: string) => import(pathToFileURL(`${root}/src/ai/${name}.ts`).href);
  const [context, decision, line, profile] = await Promise.all([
    load('context'),
    load('decision'),
    load('line'),
    load('profile'),
  ]);
  code = {
    buildDecisionContext: context.buildDecisionContext,
    decide: decision.decide,
    deriveLineContext: line.deriveLineContext,
    emptyHeroProfile: profile.emptyHeroProfile,
    summarizePlayerHand: profile.summarizePlayerHand,
    updateHeroProfile: profile.updateHeroProfile,
  };
  console.log(`(reader plays the code in ${root})`);
}

/**
 * The opponent read at a decision: the current or previous street's
 * aggressor, else the pre-flop raiser, else a lone opponent.
 */
export function readerTarget(game: GameState, idx: number): number {
  const self = game.players[idx].id;
  const line = code.deriveLineContext(game, idx, new Set());
  const live = game.players.filter((p) => p.id !== self && !p.folded);
  for (const id of [line.currentAggressorId, line.previousAggressorId, line.preflopAggressorId]) {
    if (id >= 0 && id !== self && live.some((p) => p.id === id)) return id;
  }
  return live.length === 1 ? live[0].id : -1;
}

export function readerDecision(
  game: GameState,
  idx: number,
  personality: Personality,
  reads: Record<number, HeroProfile>,
  meta: Omit<ContextMeta, 'profiledPlayerIds'>,
  rng: () => number,
): AIDecision {
  const target = readerTarget(game, idx);
  const ctx = code.buildDecisionContext(game, idx, {
    ...meta,
    profiledPlayerIds: new Set(target >= 0 ? [target] : []),
  });
  return code.decide({
    personality,
    difficulty: 'hard',
    ctx,
    rng,
    heroProfile: target >= 0 ? (reads[target] ?? code.emptyHeroProfile()) : undefined,
  });
}

/** Fold a finished hand into the reader's profile of every other player. */
export function updateReads(reads: Record<number, HeroProfile>, game: GameState, readerId: number): void {
  for (const p of game.players) {
    if (p.id === readerId) continue;
    reads[p.id] = code.updateHeroProfile(reads[p.id] ?? code.emptyHeroProfile(), code.summarizePlayerHand(game, p.id));
  }
}
