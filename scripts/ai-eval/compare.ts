/**
 * Pairs two duplicate evaluations run on the same seeds, deal by deal: the
 * difference of the bot's result between the two versions of the AI and its
 * standard error. Since both runs share the cards and every random draw, only
 * the deals where the versions decide differently contribute, and the error is
 * far smaller than that of either run alone.
 *
 *   npm run eval:ai -- <bot> 1000 11,22 6 base.json     (on the base version)
 *   npm run eval:ai -- <bot> 1000 11,22 6 new.json      (on the new version)
 *   npx tsx scripts/ai-eval/compare.ts base.json new.json
 *
 * Negative differences mean the new version wins more from the bot.
 */
import { readFileSync } from 'node:fs';

type Run = { bot: string; dealsPerSeed: number; seeds: number[]; seatCount: number; perDeal: number[] };

const [baseFile, newFile] = process.argv.slice(2);
if (!baseFile || !newFile) {
  console.error('Usage: compare.ts <base.json> <new.json>');
  process.exit(1);
}
const load = (file: string): Run => JSON.parse(readFileSync(file, 'utf8'));
const base = load(baseFile);
const next = load(newFile);
if (
  base.bot !== next.bot ||
  base.dealsPerSeed !== next.dealsPerSeed ||
  base.seatCount !== next.seatCount ||
  base.seeds.join() !== next.seeds.join()
) {
  console.error('The two runs must use the same bot, deals, seeds and seats.');
  process.exit(1);
}

const summary = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean: mean * 100, se: Math.sqrt(variance / xs.length) * 100 };
};
const fmt = ({ mean, se }: { mean: number; se: number }, sign = false) =>
  `${sign && mean >= 0 ? '+' : ''}${mean.toFixed(1)} ±${se.toFixed(1)}`;
const diffs = next.perDeal.map((x, i) => x - base.perDeal[i]);
const unchanged = diffs.filter((x) => x === 0).length;
console.log(
  `${next.bot}: base ${fmt(summary(base.perDeal))}, new ${fmt(summary(next.perDeal))}, ` +
    `paired difference ${fmt(summary(diffs), true)} bb/100 ` +
    `(${((100 * unchanged) / diffs.length).toFixed(0)}% of ${diffs.length} deals unchanged)`,
);
