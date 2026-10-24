/**
 * Pairs two evaluations run on the same seeds, deal by deal: the difference of
 * a result between the two versions of the AI and its standard error. Since
 * both runs share the cards and every random draw, only the deals where the
 * versions decide differently contribute, and the error is far smaller than
 * that of either run alone.
 *
 *   npm run eval:ai -- <bot> 1000 11,22 6 base.json     (on the base version)
 *   npm run eval:ai -- <bot> 1000 11,22 6 new.json      (on the new version)
 *   npx tsx scripts/ai-eval/compare.ts base.json new.json
 *
 * Negative differences mean the new version wins more from the bot. Style
 * runs (`styles.ts`) compare per style, each side a comma-separated list of
 * the runs' files, paired in order (so runs on the same seeds, such as one
 * lineup in both seat orders, pool):
 *
 *   npx tsx scripts/ai-eval/compare.ts base-a.json,base-b.json new-a.json,new-b.json
 */
import { readFileSync } from 'node:fs';
import { BB_CHIPS } from '../../src/engine/gameTypes';

type Run = { bot: string; dealsPerSeed: number; seeds: number[]; seatCount: number; perDeal: number[] };
type StyleEntry = { seed: number; index: number; style: string; tally: { hands: number }; perDeal: number[] };

const [baseArg, newArg] = process.argv.slice(2);
if (!baseArg || !newArg) {
  console.error('Usage: compare.ts <base.json[,more.json]> <new.json[,more.json]>');
  process.exit(1);
}
const load = (arg: string): unknown[] => arg.split(',').map((file) => JSON.parse(readFileSync(file, 'utf8')));

const summary = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean: mean * 100, se: Math.sqrt(variance / xs.length) * 100 };
};
const fmt = ({ mean, se }: { mean: number; se: number }, sign = false) =>
  `${sign && mean >= 0 ? '+' : ''}${mean.toFixed(1)} ±${se.toFixed(1)}`;

const baseRuns = load(baseArg);
const newRuns = load(newArg);
if (Array.isArray(baseRuns[0])) {
  if (baseRuns.length !== newRuns.length) {
    console.error('Both sides must list the same number of style runs.');
    process.exit(1);
  }
  compareStyles(baseRuns as StyleEntry[][], newRuns as StyleEntry[][]);
} else {
  compareDuplicate(baseRuns[0] as Run, newRuns[0] as Run);
}

function compareDuplicate(base: Run, next: Run): void {
  if (
    base.bot !== next.bot ||
    base.dealsPerSeed !== next.dealsPerSeed ||
    base.seatCount !== next.seatCount ||
    base.seeds.join() !== next.seeds.join()
  ) {
    console.error('The two runs must use the same bot, deals, seeds and seats.');
    process.exit(1);
  }
  const diffs = next.perDeal.map((x, i) => x - base.perDeal[i]);
  const unchanged = diffs.filter((x) => x === 0).length;
  console.log(
    `${next.bot}: base ${fmt(summary(base.perDeal))}, new ${fmt(summary(next.perDeal))}, ` +
      `paired difference ${fmt(summary(diffs), true)} bb/100 ` +
      `(${((100 * unchanged) / diffs.length).toFixed(0)}% of ${diffs.length} deals unchanged)`,
  );
}

/** Per style: bb/100 of both versions and their paired difference over the deals. */
function compareStyles(baseRuns: StyleEntry[][], nextRuns: StyleEntry[][]): void {
  const key = (e: StyleEntry) => `${e.seed}:${e.index}`;
  const styles = [...new Set(baseRuns.flat().map((e) => e.style))];
  for (const style of styles) {
    const baseSamples: number[] = [];
    const nextSamples: number[] = [];
    baseRuns.forEach((base, run) => {
      const nextByKey = new Map(nextRuns[run].map((e) => [key(e), e]));
      for (const seed of new Set(base.map((e) => e.seed))) {
        const group = base.filter((e) => e.seed === seed && e.style === style);
        if (group.length === 0) continue;
        const pairs = group.map((e) => nextByKey.get(key(e)));
        if (pairs.some((e) => !e || e.style !== style)) {
          console.error(`Seed ${seed} of run ${run + 1} does not match between the two sides.`);
          process.exit(1);
        }
        const deals = group[0].perDeal.length;
        const handsPerDeal = group.reduce((s, e) => s + e.tally.hands, 0) / deals;
        for (let d = 0; d < deals; d++) {
          baseSamples.push(group.reduce((s, e) => s + e.perDeal[d], 0) / handsPerDeal / BB_CHIPS);
          nextSamples.push(pairs.reduce((s, e) => s + e!.perDeal[d], 0) / handsPerDeal / BB_CHIPS);
        }
      }
    });
    const diffs = nextSamples.map((x, i) => x - baseSamples[i]);
    console.log(
      `${style.padEnd(9)} base ${fmt(summary(baseSamples)).padStart(12)}, new ${fmt(summary(nextSamples)).padStart(12)}, ` +
        `paired difference ${fmt(summary(diffs), true).padStart(11)} bb/100`,
    );
  }
}
