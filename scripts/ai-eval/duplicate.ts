/**
 * Duplicate evaluation of the hard AI against one scripted opponent (`bots.ts`).
 * Every deal is replayed once per seat with the bot in that seat, so the bot
 * plays each deal from every position and card luck largely cancels. Each
 * rotation keeps its own AI table images and profile of the bot, as a real
 * table would.
 *
 *   npm run eval:ai -- <bot> [dealsPerSeed=1000] [seeds=11,22] [seats=6] [out.json]
 *
 * Prints the bot's result in bb/100 (negative: the AI wins) with its standard
 * error, and how the AI answers the bot's bets by street and size class.
 *
 * Every decision, the bot's and the AI's, draws from its own stream seeded by
 * its place in the run (seed, deal, rotation, action), so two versions of the
 * AI run on the same seeds see the same cards and the same random draws and
 * part ways only where they decide differently. `out.json` keeps the per-deal
 * results; `compare.ts` pairs two such files deal by deal.
 */
import { writeFileSync } from 'node:fs';
import { applyAction, startHand, type SeatInit } from '../../src/engine/game';
import { BB_CHIPS, type ActionRecord, type GameConfig, type GameState } from '../../src/engine/gameTypes';
import { buildDecisionContext } from '../../src/ai/context';
import { decide } from '../../src/ai/decision';
import { effectiveImage, sampleHandImage, updateTableImage, type TableImage } from '../../src/ai/image';
import { generatePersonality } from '../../src/ai/personality';
import { betSizeClass, emptyHeroProfile, summarizePlayerHand, updateHeroProfile } from '../../src/ai/profile';
import { BOTS, seeded, type Bot } from './bots';

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
type Responses = Record<string, { n: number; fold: number; call: number; raise: number }>;

function wagerToPot(a: ActionRecord): number {
  const wager = a.raiseBy && a.raiseBy > 0 ? a.raiseBy : (a.chipsPutIn ?? a.amount);
  return wager / Math.max(1, a.potBefore);
}

/** Tally the AI's answers to bets and raises made by the bot's seat. */
function tallyResponses(game: GameState, botId: number, out: Responses): void {
  for (const street of ['flop', 'turn', 'river'] as const) {
    const actions = game.history.filter((a) => a.street === street);
    actions.forEach((a, i) => {
      if (a.playerId === botId || a.toCall <= 0) return;
      const lastAggressor = actions
        .slice(0, i)
        .reverse()
        .find((x) => AGGRESSIVE.has(x.type));
      if (lastAggressor?.playerId !== botId) return;
      const t = (out[`${street}:${betSizeClass(wagerToPot(lastAggressor))}`] ??= { n: 0, fold: 0, call: 0, raise: 0 });
      t.n++;
      if (a.type === 'fold') t.fold++;
      else if (a.type === 'call') t.call++;
      else t.raise++;
    });
  }
}

/** FNV-1a style mix of the coordinates of one decision into a seed. */
function decisionSeed(...coordinates: number[]): number {
  let h = 2166136261;
  for (const x of coordinates) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Per-deal bot net (chips, summed over the seat rotations) for one seed. */
function runDuplicate(bot: Bot, deals: number, seed: number, seatCount: number, responses: Responses): number[] {
  const stackBB = 100;
  const config: GameConfig = { seatCount, blindLevel: 1, startingStackBB: stackBB, difficulty: 'hard' };
  const personalities = Array.from({ length: seatCount }, (_, i) =>
    generatePersonality('hard', seeded(seed * 31 + i)),
  );
  const rotations = Array.from({ length: seatCount }, () => ({
    profile: emptyHeroProfile(),
    images: {} as Record<number, TableImage>,
  }));
  const perDeal: number[] = [];
  for (let d = 0; d < deals; d++) {
    let dealNet = 0;
    for (let k = 0; k < seatCount; k++) {
      const rot = rotations[k];
      const seats: SeatInit[] = Array.from({ length: seatCount }, (_, i) => ({
        id: i,
        name: `P${i}`,
        isHero: i === k,
        stack: stackBB * BB_CHIPS,
      }));
      // The same deal (cards and button) for every rotation.
      let game = startHand(config, seats, d % seatCount, d + 1, seeded(seed * 1000003 + d * 7 + 13));
      const bluffCount: Record<number, number> = {};
      const lastBluffStreet: Record<number, GameState['street']> = {};
      for (let step = 0; game.status === 'betting' && step < 400; step++) {
        const idx = game.toAct;
        if (idx < 0) break;
        if (idx === k) {
          game = applyAction(game, bot(game, idx, seeded(decisionSeed(seed, d, k, step, 2))));
          continue;
        }
        const ctx = buildDecisionContext(game, idx, {
          recentImage: effectiveImage(rot.images[idx]),
          bluffCount: bluffCount[idx] ?? 0,
          lastBluffStreet: lastBluffStreet[idx],
        });
        const decision = decide({
          personality: personalities[idx],
          difficulty: 'hard',
          ctx,
          rng: seeded(decisionSeed(seed, d, k, step, 1)),
          heroProfile: game.players[k].folded ? undefined : rot.profile,
        });
        if (decision.isBluff) {
          bluffCount[idx] = (bluffCount[idx] ?? 0) + 1;
          lastBluffStreet[idx] = game.street;
        }
        game = applyAction(game, { type: decision.action, amount: decision.amount });
      }
      dealNet += game.players[k].stack - stackBB * BB_CHIPS;
      tallyResponses(game, k, responses);
      rot.profile = updateHeroProfile(rot.profile, summarizePlayerHand(game, k));
      for (const p of game.players) {
        rot.images[p.id] = updateTableImage(rot.images[p.id], sampleHandImage(game, p.id));
      }
    }
    perDeal.push(dealNet);
  }
  return perDeal;
}

const [botName = 'abc', dealsArg = '1000', seedsArg = '11,22', seatsArg = '6', outFile] = process.argv.slice(2);
const bot = BOTS[botName];
if (!bot) {
  console.error(`Unknown bot "${botName}". Choose one of: ${Object.keys(BOTS).join(', ')}`);
  process.exit(1);
}
const deals = Number(dealsArg);
const seeds = seedsArg.split(',').map(Number);
const seatCount = Number(seatsArg);

const started = Date.now();
const responses: Responses = {};
const perHand = seeds
  .flatMap((seed) => runDuplicate(bot, deals, seed, seatCount, responses))
  .map((chips) => chips / seatCount / BB_CHIPS);
const mean = perHand.reduce((a, b) => a + b, 0) / perHand.length;
const variance = perHand.reduce((a, b) => a + (b - mean) ** 2, 0) / (perHand.length - 1);
const standardError = Math.sqrt(variance / perHand.length);
if (outFile) {
  writeFileSync(outFile, JSON.stringify({ bot: botName, dealsPerSeed: deals, seeds, seatCount, perDeal: perHand }));
}

console.log(
  `${botName}: ${perHand.length} deals x ${seatCount} seats, bot ${(mean * 100).toFixed(1)} ` +
    `±${(standardError * 100).toFixed(1)} bb/100 (${((Date.now() - started) / 1000).toFixed(0)}s)`,
);
const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(0)}%`;
for (const [key, t] of Object.entries(responses).sort()) {
  console.log(
    `  AI vs bot ${key.padEnd(13)} n=${String(t.n).padStart(5)} fold ${pct(t.fold, t.n)} call ${pct(t.call, t.n)} raise ${pct(t.raise, t.n)}`,
  );
}
