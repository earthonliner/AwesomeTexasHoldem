/**
 * How each hard style fares against the others at a 6-max table, and where its
 * chips go. Every deal is played once per seat rotation: the lineup shifts one
 * seat each time, so every personality plays the deal's cards from every seat
 * and card luck largely cancels. Stacks reset to 100bb every hand.
 *
 * Without a `reader` in the lineup nobody is profiled (the AIs read only the
 * human). A `reader` seat stands in for the human (`reader.ts`): the AIs keep
 * a profile of it as they do of the human, it keeps one of each of them, and
 * the report adds the AIs' results in the hands it played.
 *
 *   npm run eval:styles -- [deals=300] [seeds=1,2] [lineup=tag,tag,lag,lag,looseLag,looseLag] [out.json]
 *   npm run eval:styles -- 600 1,2 reader,tag,lag,lag,looseLag,looseLag
 *   npm run eval:styles -- a.json b.json ...     merge saved runs and report
 *
 * The seat order of the lineup matters (it fixes who acts after whom), so a
 * comparison of styles should be run in both orders, e.g. also
 * `reader,looseLag,looseLag,lag,lag,tag`.
 *
 * Every decision draws from its own stream seeded by its place in the run
 * (seed, deal, rotation, action), so two versions of the AI see the same cards
 * and the same random draws and part ways only where they decide differently.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { applyAction, startHand, type SeatInit } from '../../src/engine/game';
import { BB_CHIPS, type GameConfig, type GameState } from '../../src/engine/gameTypes';
import { buildDecisionContext } from '../../src/ai/context';
import { decide } from '../../src/ai/decision';
import { effectiveImage, sampleHandImage, updateTableImage, type TableImage } from '../../src/ai/image';
import { tablePositionFor } from '../../src/ai/line';
import { HARD_STYLES, hardStylePersonality, type HardStyle } from '../../src/ai/personality';
import { betSizeClass, emptyHeroProfile, summarizePlayerHand, updateHeroProfile } from '../../src/ai/profile';
import type { HeroProfile, Personality } from '../../src/ai/types';
import { seeded } from './bots';
import { readerDecision, updateReads, useReaderFrom } from './reader';

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
const STACK_BB = 100;

interface Bucket {
  n: number;
  net: number;
}

interface Tally {
  hands: number;
  net: number;
  vpip: number;
  pfr: number;
  threeBetChances: number;
  threeBets: number;
  threeBetsFaced: number;
  threeBetFolds: number;
  sawFlop: number;
  showdowns: number;
  showdownWins: number;
  showdownNet: number;
  postBets: number;
  postCalls: number;
  /** Post-flop bets and raises the AI marks as bluffs, and those that took the pot at once. */
  bluffs: number;
  bluffsThrough: number;
  /** River calls of a bet, and those that won the pot. */
  riverCalls: number;
  riverCallWins: number;
  lines: Record<string, Bucket>;
  positions: Record<string, Bucket>;
  /** Hands that saw a flop, by the pre-flop role and the number of players on the flop. */
  flopRoles: Record<string, Bucket>;
  /** The same for the hands the reader put chips in voluntarily (AIs only). */
  readerHands: number;
  readerNet: number;
  readerLines: Record<string, Bucket>;
  readerFlopRoles: Record<string, Bucket>;
  /** Those hands by the AI's seat counted clockwise from the reader (`+5` sits on its right). */
  readerSeats: Record<string, Bucket>;
  /** Answers to a street's opening bet heads-up, by `street:size:bettor` (bettor `reader` or `ai`). */
  faced: Record<string, Answers>;
}

interface Answers {
  n: number;
  fold: number;
  call: number;
  raise: number;
}

/** The non-scripted stand-in for an observant human (`reader.ts`), tight-aggressive. */
const READER = 'reader';
type Seat = HardStyle | typeof READER;

interface Entry {
  seed: number;
  index: number;
  style: Seat;
  personality: Personality;
  tally: Tally;
  /** Net chips per deal, summed over the rotations. */
  perDeal: number[];
  /** Profile counters of this player as the AIs keep them (on the reader) or would (on an AI), summed over the rotations. */
  observed?: Record<string, number>;
}

const emptyTally = (): Tally => ({
  hands: 0,
  net: 0,
  vpip: 0,
  pfr: 0,
  threeBetChances: 0,
  threeBets: 0,
  threeBetsFaced: 0,
  threeBetFolds: 0,
  sawFlop: 0,
  showdowns: 0,
  showdownWins: 0,
  showdownNet: 0,
  postBets: 0,
  postCalls: 0,
  bluffs: 0,
  bluffsThrough: 0,
  riverCalls: 0,
  riverCallWins: 0,
  lines: {},
  positions: {},
  flopRoles: {},
  readerHands: 0,
  readerNet: 0,
  readerLines: {},
  readerFlopRoles: {},
  readerSeats: {},
  faced: {},
});

function add(buckets: Record<string, Bucket>, key: string, net: number): void {
  const b = (buckets[key] ??= { n: 0, net: 0 });
  b.n++;
  b.net += net;
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

/**
 * The player's pre-flop line: its first voluntary action and the pot it met
 * (`open`, `complete`, `iso`, `overlimp`, `bb-check`, `bb-call`, `sb-call`,
 * `cold-call`, `3bet`, `call-3bet`, `4bet`), then its answer when raised
 * after it (`>fold`, `>call`, `>raise`). Folds without a chip in are `fold`,
 * blinds folded are `blind-fold`, the big blind's walk is `walk`.
 */
function preflopLine(game: GameState, playerId: number): string {
  const seat = game.players.findIndex((p) => p.id === playerId);
  const position = tablePositionFor(game, seat);
  const pre = game.history.filter((a) => a.street === 'preflop');
  if (game.board.length === 0 && pre.length > 0 && pre.every((a) => a.type === 'fold') && position === 'bb') {
    return 'walk';
  }
  let raises = 0;
  let limpers = 0;
  let first: string | null = null;
  let raisesAtFirst = 0;
  let answer: string | null = null;
  for (const a of pre) {
    if (a.playerId === playerId) {
      const kind = AGGRESSIVE.has(a.type) ? 'raise' : a.type;
      if (first === null) {
        raisesAtFirst = raises;
        if (kind === 'fold') first = position === 'sb' || position === 'bb' ? 'blind-fold' : 'fold';
        else if (kind === 'check') first = 'bb-check';
        else if (raises === 0) {
          if (limpers === 0) first = kind === 'raise' ? 'open' : 'complete';
          else first = kind === 'raise' ? 'iso' : 'overlimp';
        } else if (raises === 1) {
          first =
            kind === 'raise'
              ? '3bet'
              : position === 'bb'
                ? 'bb-call'
                : position === 'sb'
                  ? 'sb-call'
                  : 'cold-call';
        } else {
          first = kind === 'raise' ? '4bet' : 'call-3bet';
        }
      } else if (answer === null && raises > raisesAtFirst) {
        answer = kind;
      }
    }
    if (AGGRESSIVE.has(a.type)) raises++;
    else if (a.type === 'call' && raises === 0) limpers++;
  }
  if (first === null) return 'fold';
  return answer ? `${first}>${answer}` : first;
}

const voluntary = (pre: GameState['history'], id: number) =>
  pre.some((a) => a.playerId === id && (AGGRESSIVE.has(a.type) || (a.type === 'call' && a.toCall > 0)));

function collect(
  game: GameState,
  personalityAt: (seat: number) => number,
  tallies: Tally[],
  bluffs: { seat: number; street: string; index: number }[],
  readerSeat: number,
): void {
  const h = game.history;
  const pre = h.filter((a) => a.street === 'preflop');
  const flopPlayers = new Set(h.filter((a) => a.street === 'flop').map((a) => a.playerId));
  let pfa = -1;
  for (const a of pre) if (AGGRESSIVE.has(a.type)) pfa = a.playerId;
  const readerPlayed = readerSeat >= 0 && voluntary(pre, game.players[readerSeat].id);

  game.players.forEach((p, seat) => {
    const t = tallies[personalityAt(seat)];
    const net = p.stack - STACK_BB * BB_CHIPS;
    const mine = pre.filter((a) => a.playerId === p.id);
    t.hands++;
    t.net += net;
    if (voluntary(pre, p.id)) t.vpip++;
    if (mine.some((a) => AGGRESSIVE.has(a.type))) t.pfr++;
    const line = preflopLine(game, p.id);
    add(t.lines, line, net);
    add(t.positions, tablePositionFor(game, seat), net);
    const role = p.id === pfa ? 'pfa' : pfa < 0 ? 'limped' : 'caller';
    const flopRole = `${role}:${flopPlayers.size === 2 ? 'hu' : 'mw'}`;
    if (readerPlayed && seat !== readerSeat) {
      t.readerHands++;
      t.readerNet += net;
      add(t.readerLines, line, net);
      add(t.readerSeats, `+${(seat - readerSeat + game.players.length) % game.players.length}`, net);
      if (flopPlayers.has(p.id)) add(t.readerFlopRoles, flopRole, net);
    }
    if (flopPlayers.has(p.id)) {
      t.sawFlop++;
      add(t.flopRoles, flopRole, net);
    }
    if (game.revealed.includes(p.id) && game.revealed.length > 1) {
      t.showdowns++;
      t.showdownNet += net;
      if (game.payouts.some((x) => x.playerId === p.id && x.amount > 0)) t.showdownWins++;
    }
  });

  // 3-bet chances (a single raise in front, first time acting on it) and folds to 3-bets.
  let raises = 0;
  let opener = -1;
  const seen = new Set<number>();
  for (const a of pre) {
    const seat = game.players.findIndex((p) => p.id === a.playerId);
    const t = tallies[personalityAt(seat)];
    if (raises === 1 && a.playerId !== opener && !seen.has(a.playerId)) {
      seen.add(a.playerId);
      t.threeBetChances++;
      if (AGGRESSIVE.has(a.type)) t.threeBets++;
    }
    if (raises === 2 && a.playerId === opener) {
      t.threeBetsFaced++;
      if (a.type === 'fold') t.threeBetFolds++;
    }
    if (AGGRESSIVE.has(a.type)) {
      raises++;
      if (raises === 1) opener = a.playerId;
    }
  }

  for (const street of ['flop', 'turn', 'river'] as const) {
    const acts = h.filter((a) => a.street === street);
    acts.forEach((a, i) => {
      const seat = game.players.findIndex((p) => p.id === a.playerId);
      const t = tallies[personalityAt(seat)];
      if (AGGRESSIVE.has(a.type)) t.postBets++;
      else if (a.type === 'call') t.postCalls++;
      if (street === 'river' && a.type === 'call' && a.toCall > 0) {
        t.riverCalls++;
        if (game.payouts.some((x) => x.playerId === a.playerId && x.amount > 0)) t.riverCallWins++;
      }
      if (bluffs.some((b) => b.street === street && b.index === i)) {
        t.bluffs++;
        // Through: nobody put another chip in after it and the hand ended on this street.
        const later = acts.slice(i + 1);
        const through =
          later.every((x) => x.type === 'fold') &&
          !h.some((x) => STREET_ORDER[x.street] > STREET_ORDER[street]) &&
          game.payouts.some((x) => x.playerId === a.playerId && x.amount > 0) &&
          game.revealed.length === 0;
        if (through) t.bluffsThrough++;
      }
    });
  }

  const folded = new Set(pre.filter((a) => a.type === 'fold').map((a) => a.playerId));
  for (const street of ['flop', 'turn', 'river'] as const) {
    const acts = h.filter((a) => a.street === street);
    const open = acts.findIndex((a) => AGGRESSIVE.has(a.type));
    if (open >= 0 && game.players.length - folded.size === 2) {
      const bet = acts[open];
      const answer = acts.slice(open + 1).find((a) => a.playerId !== bet.playerId);
      if (answer) {
        const seat = game.players.findIndex((p) => p.id === answer.playerId);
        const from = game.players.findIndex((p) => p.id === bet.playerId) === readerSeat ? 'reader' : 'ai';
        const wager = bet.raiseBy && bet.raiseBy > 0 ? bet.raiseBy : (bet.chipsPutIn ?? bet.amount);
        const key = `${street}:${betSizeClass(wager / Math.max(1, bet.potBefore))}:${from}`;
        const r = (tallies[personalityAt(seat)].faced[key] ??= { n: 0, fold: 0, call: 0, raise: 0 });
        r.n++;
        r[answer.type === 'fold' ? 'fold' : AGGRESSIVE.has(answer.type) ? 'raise' : 'call']++;
      }
    }
    for (const a of acts) if (a.type === 'fold') folded.add(a.playerId);
  }
}

const STREET_ORDER: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3, showdown: 4 };

/**
 * The lineup in seat order for one seed. The seat rotations keep the order
 * around the table, so the reader keeps its place and the others shift one
 * seat per seed: over n-1 seeds every style sits at every distance from it.
 */
function seating(lineup: Seat[], seed: number): Seat[] {
  const r = lineup.indexOf(READER);
  if (r < 0) return lineup;
  const others = lineup.filter((_, i) => i !== r);
  const shift = seed % others.length;
  const rotated = [...others.slice(shift), ...others.slice(0, shift)];
  return [...rotated.slice(0, r), READER, ...rotated.slice(r)];
}

function runSeed(deals: number, seed: number, baseLineup: Seat[]): Entry[] {
  const lineup = seating(baseLineup, seed);
  const n = lineup.length;
  const config: GameConfig = { seatCount: n, blindLevel: 1, startingStackBB: STACK_BB, difficulty: 'hard' };
  const personalities = lineup.map((style, i) =>
    hardStylePersonality(style === READER ? 'tag' : style, seeded(seed * 31 + i)),
  );
  const readerIndex = lineup.indexOf(READER);
  const tallies = personalities.map(() => emptyTally());
  const perDeal = personalities.map(() => [] as number[]);
  const rotations = Array.from({ length: n }, () => ({
    images: {} as Record<number, TableImage>,
    /** The AIs' profile of the reader, and the reader's profiles of the AIs (by seat). */
    readerProfile: emptyHeroProfile(),
    reads: {} as Record<number, HeroProfile>,
    /** The AIs' habits as this checkout profiles them, for the report (by seat). */
    aiProfiles: {} as Record<number, HeroProfile>,
  }));
  for (let d = 0; d < deals; d++) {
    const dealNet = personalities.map(() => 0);
    for (let k = 0; k < n; k++) {
      // Personality j sits in seat (j + k) % n for this rotation.
      const personalityAt = (seat: number) => (seat - k + n) % n;
      const readerSeat = readerIndex >= 0 ? (readerIndex + k) % n : -1;
      const seats: SeatInit[] = Array.from({ length: n }, (_, i) => ({
        id: i,
        name: `P${i}`,
        isHero: i === readerSeat,
        stack: STACK_BB * BB_CHIPS,
      }));
      let game = startHand(config, seats, d % n, d + 1, seeded(seed * 1000003 + d * 7 + 13));
      const bluffCount: Record<number, number> = {};
      const lastBluffStreet: Record<number, GameState['street']> = {};
      const bluffs: { seat: number; street: string; index: number }[] = [];
      const rot = rotations[k];
      for (let step = 0; game.status === 'betting' && step < 400; step++) {
        const idx = game.toAct;
        if (idx < 0) break;
        const meta = {
          recentImage: effectiveImage(rot.images[personalityAt(idx)]),
          bluffCount: bluffCount[idx] ?? 0,
          lastBluffStreet: lastBluffStreet[idx],
        };
        const rng = seeded(decisionSeed(seed, d, k, step, 1));
        const decision =
          idx === readerSeat
            ? readerDecision(game, idx, personalities[personalityAt(idx)], rot.reads, meta, rng)
            : decide({
                personality: personalities[personalityAt(idx)],
                difficulty: 'hard',
                ctx: buildDecisionContext(game, idx, meta),
                rng,
                heroProfile: readerSeat >= 0 && !game.players[readerSeat].folded ? rot.readerProfile : undefined,
              });
        if (decision.isBluff) {
          bluffCount[idx] = (bluffCount[idx] ?? 0) + 1;
          lastBluffStreet[idx] = game.street;
          if (game.street !== 'preflop') {
            bluffs.push({
              seat: idx,
              street: game.street,
              index: game.history.filter((a) => a.street === game.street).length,
            });
          }
        }
        game = applyAction(game, { type: decision.action, amount: decision.amount });
      }
      collect(game, personalityAt, tallies, bluffs, readerSeat);
      game.players.forEach((p, seat) => {
        dealNet[personalityAt(seat)] += p.stack - STACK_BB * BB_CHIPS;
        rot.images[personalityAt(seat)] = updateTableImage(rot.images[personalityAt(seat)], sampleHandImage(game, p.id));
      });
      if (readerSeat >= 0) {
        rot.readerProfile = updateHeroProfile(rot.readerProfile, summarizePlayerHand(game, readerSeat));
        updateReads(rot.reads, game, readerSeat);
        for (const p of game.players) {
          if (p.id === readerSeat) continue;
          rot.aiProfiles[p.id] = updateHeroProfile(rot.aiProfiles[p.id] ?? emptyHeroProfile(), summarizePlayerHand(game, p.id));
        }
      }
    }
    dealNet.forEach((x, j) => perDeal[j].push(x));
  }
  const observed = (index: number): Record<string, number> | undefined => {
    if (readerIndex < 0) return undefined;
    const sum: Record<string, number> = {};
    rotations.forEach((rot, k) => {
      const profile = index === readerIndex ? rot.readerProfile : rot.aiProfiles[(index + k) % n];
      for (const [key, x] of Object.entries(profile?.counters ?? {})) sum[key] = (sum[key] ?? 0) + x;
    });
    return sum;
  };
  return personalities.map((personality, index) => ({
    seed,
    index,
    style: lineup[index],
    personality,
    tally: tallies[index],
    perDeal: perDeal[index],
    observed: observed(index),
  }));
}

function mergeTallies(tallies: Tally[]): Tally {
  const out = emptyTally();
  for (const t of tallies) {
    for (const key of Object.keys(out) as (keyof Tally)[]) {
      const value = t[key];
      if (value === undefined) continue;
      if (typeof value === 'number') (out[key] as number) += value;
      else {
        const target = out[key] as unknown as Record<string, Record<string, number>>;
        for (const [k, b] of Object.entries(value as unknown as Record<string, Record<string, number>>)) {
          const into = (target[k] ??= {});
          for (const [field, x] of Object.entries(b)) into[field] = (into[field] ?? 0) + x;
        }
      }
    }
  }
  return out;
}

const bb100 = (chips: number, hands: number) => (100 * chips) / BB_CHIPS / Math.max(1, hands);
const pct = (x: number, n: number) => (n === 0 ? '—' : `${((100 * x) / n).toFixed(1)}%`);

/** bb/100 of a group of entries with its standard error over the deals. */
function groupResult(entries: Entry[]): { mean: number; se: number; hands: number } {
  const bySeed = new Map<number, Entry[]>();
  for (const e of entries) bySeed.set(e.seed, [...(bySeed.get(e.seed) ?? []), e]);
  const samples: number[] = [];
  let hands = 0;
  for (const group of bySeed.values()) {
    const deals = group[0].perDeal.length;
    const handsPerDeal = group.reduce((s, e) => s + e.tally.hands, 0) / Math.max(1, deals);
    hands += group.reduce((s, e) => s + e.tally.hands, 0);
    for (let d = 0; d < deals; d++) {
      samples.push(group.reduce((s, e) => s + e.perDeal[d], 0) / handsPerDeal / BB_CHIPS);
    }
  }
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, samples.length - 1);
  return { mean: mean * 100, se: Math.sqrt(variance / Math.max(1, samples.length)) * 100, hands };
}

function report(entries: Entry[]): void {
  const styles = ([...Object.keys(HARD_STYLES), READER] as Seat[]).filter((s) => entries.some((e) => e.style === s));
  const merged = new Map(styles.map((s) => [s, mergeTallies(entries.filter((e) => e.style === s).map((e) => e.tally))]));
  const seeds = [...new Set(entries.map((e) => e.seed))];
  const withReader = styles.includes(READER);
  console.log(
    `${seeds.length} seeds, ${entries[0].perDeal.length} deals per seed x ${entries.filter((e) => e.seed === seeds[0]).length} rotations`,
  );
  const header = (label: string) =>
    console.log(`\n  ${label.padEnd(24)}${styles.map((s) => s.padStart(18)).join('')}`);
  const row = (label: string, cell: (t: Tally, s: Seat) => string) =>
    console.log(`  ${label.padEnd(24)}${styles.map((s) => cell(merged.get(s)!, s).padStart(18)).join('')}`);

  header('style');
  row('bb/100', (_, s) => {
    const r = groupResult(entries.filter((e) => e.style === s));
    return `${r.mean.toFixed(1)} ±${r.se.toFixed(1)}`;
  });
  row('hands', (t) => String(t.hands));
  row('VPIP / PFR', (t) => `${pct(t.vpip, t.hands)} / ${pct(t.pfr, t.hands)}`);
  row('3-bet / fold to 3-bet', (t) => `${pct(t.threeBets, t.threeBetChances)} / ${pct(t.threeBetFolds, t.threeBetsFaced)}`);
  row('saw flop / WTSD', (t) => `${pct(t.sawFlop, t.hands)} / ${pct(t.showdowns, t.sawFlop)}`);
  row('W$SD', (t) => pct(t.showdownWins, t.showdowns));
  row('AF (bets / calls)', (t) => (t.postBets / Math.max(1, t.postCalls)).toFixed(2));
  row('bluffs / through', (t) => `${pct(t.bluffs, t.postBets)} / ${pct(t.bluffsThrough, t.bluffs)}`);
  row('river calls won', (t) => `${pct(t.riverCallWins, t.riverCalls)} (${t.riverCalls})`);
  row('showdown bb/100', (t) => bb100(t.showdownNet, t.hands).toFixed(1));
  row('non-showdown bb/100', (t) => bb100(t.net - t.showdownNet, t.hands).toFixed(1));
  if (withReader) {
    row('in hands reader played', (t, s) =>
      s === READER ? '—' : `${bb100(t.readerNet, t.hands).toFixed(1)} (${pct(t.readerHands, t.hands)})`,
    );
  }

  const section = (label: string, pick: (t: Tally) => Record<string, Bucket>, order?: string[]) => {
    const keys = new Set<string>();
    for (const t of merged.values()) for (const k of Object.keys(pick(t))) keys.add(k);
    const sorted = [...keys].sort((a, b) => {
      if (order) {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }
      return a.localeCompare(b);
    });
    header(`${label}: bb/100 (share)`);
    for (const k of sorted) {
      row(k, (t) => {
        const b = pick(t)[k];
        if (!b) return '—';
        return `${bb100(b.net, t.hands).toFixed(1)} (${pct(b.n, t.hands)})`;
      });
    }
  };
  section('position', (t) => t.positions, ['early', 'middle', 'hj', 'co', 'btn', 'sb', 'bb']);
  section('pre-flop line', (t) => t.lines);
  section('flop role', (t) => t.flopRoles);
  if (withReader) {
    section('reader hands: line', (t) => t.readerLines);
    section('reader hands: flop role', (t) => t.readerFlopRoles);
    section('reader hands: seat', (t) => t.readerSeats);
  }

  const streetRank = (k: string) => ['flop', 'turn', 'river'].indexOf(k.split(':')[0]);
  const sizeRank = (k: string) => ['small', 'medium', 'big'].indexOf(k.split(':')[1]);
  const answerKeys = [...new Set([...merged.values()].flatMap((t) => Object.keys(t.faced)))].sort(
    (a, b) => streetRank(a) - streetRank(b) || sizeRank(a) - sizeRank(b) || a.localeCompare(b),
  );
  header('HU vs opening bet: fold / raise (n)');
  for (const k of answerKeys) {
    row(k, (t) => {
      const r = t.faced[k];
      return r ? `${pct(r.fold, r.n)} / ${pct(r.raise, r.n)} (${r.n})` : '—';
    });
  }

  if (withReader) {
    const observed = new Map(
      styles.map((s) => {
        const sum: Record<string, number> = {};
        for (const e of entries.filter((x) => x.style === s)) {
          for (const [key, x] of Object.entries(e.observed ?? {})) sum[key] = (sum[key] ?? 0) + x;
        }
        return [s, sum];
      }),
    );
    const rate = (label: string, num: string, den: string) => {
      console.log(
        `  ${label.padEnd(24)}${styles
          .map((s) => {
            const c = observed.get(s)!;
            return `${pct(c[num] ?? 0, c[den] ?? 0)} (${c[den] ?? 0})`.padStart(18);
          })
          .join('')}`,
      );
    };
    header('as profiled by the other side');
    rate('fold to steal', 'stealFacedFolds', 'stealFaced');
    rate('3-bet', 'threeBets', 'threeBetChances');
    rate('fold to 3-bet', 'threeBetFolds', 'threeBetsFaced');
    rate('fold to c-bet', 'cbetFolded', 'cbetFaced');
    rate('c-bet / barrel', 'continuationBets', 'continuationChances');
    rate('fold to river bet', 'riverBetFolds', 'riverBetsFaced');
    rate('fold when raised', 'raisesFolded', 'raisesFaced');
    rate('re-raise when raised', 'raisesReraised', 'raisesFaced');
    rate('WTSD (per flop)', 'flopShowdowns', 'flopsSeen');
    rate('river bets shown weak', 'riverBetsWeak', 'riverBetsShown');
    rate('  big', 'riverBigWeak', 'riverBigShown');
    rate('  small', 'riverSmallWeak', 'riverSmallShown');
  }

  console.log('\n  seed idx  style       vpip  bluff  aggr  call   bb/100');
  for (const e of entries) {
    const r = groupResult([e]);
    const p = e.personality;
    console.log(
      `  ${String(e.seed).padStart(4)} ${String(e.index).padStart(3)}  ${e.style.padEnd(9)} ${p.vpip.toFixed(2).padStart(6)} ${p.bluff
        .toFixed(2)
        .padStart(6)} ${p.aggression.toFixed(2).padStart(5)} ${p.callDown.toFixed(2).padStart(5)} ${`${r.mean.toFixed(1)} ±${r.se.toFixed(1)}`.padStart(13)}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.length > 0 && args.every((a) => a.endsWith('.json'))) {
  report(args.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')) as Entry[]));
} else {
  const [dealsArg = '300', seedsArg = '1,2', lineupArg = 'tag,tag,lag,lag,looseLag,looseLag', outFile] = args;
  const lineup = lineupArg.split(',') as Seat[];
  for (const s of lineup) {
    if (!(s in HARD_STYLES) && s !== READER) {
      console.error(`Unknown style "${s}". Choose from: ${[...Object.keys(HARD_STYLES), READER].join(', ')}`);
      process.exit(1);
    }
  }
  if (lineup.filter((s) => s === READER).length > 1) {
    console.error('At most one reader per table.');
    process.exit(1);
  }
  await useReaderFrom(process.env.READER_FROM);
  const started = Date.now();
  const entries = seedsArg
    .split(',')
    .map(Number)
    .flatMap((seed) => runSeed(Number(dealsArg), seed, lineup));
  if (outFile) writeFileSync(outFile, JSON.stringify(entries));
  console.log(`(${((Date.now() - started) / 1000).toFixed(0)}s)`);
  report(entries);
}
