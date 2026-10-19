/**
 * Behaviour of a hard-AI table playing itself (6-max, 100bb by default):
 * looseness, opens by position, how often the big blind gets a walk,
 * post-flop c-bets / barrels / check-raises, how often multiway pots check
 * through, the bluff share of the bets, and showdown rates. Seat 0 stands in
 * for the human: its profile is kept and handed to the AIs while it is in the
 * hand, as the single-player store does.
 *
 *   npx tsx scripts/ai-eval/population.ts [hands=3000] [seeds=4242,777] [seats=6]
 *
 * Every decision draws from its own stream seeded by its place in the run
 * (seed, hand, action), so two versions of the AI see the same cards and the
 * same random draws and part ways only where they decide differently.
 */
import { applyAction, startHand, type SeatInit } from '../../src/engine/game';
import { BB_CHIPS, type GameConfig, type GameState } from '../../src/engine/gameTypes';
import { evaluateHand } from '../../src/engine/handEvaluator';
import { HandCategory, type Card } from '../../src/engine/types';
import { buildDecisionContext } from '../../src/ai/context';
import { decide } from '../../src/ai/decision';
import { analyseHand } from '../../src/ai/handFeatures';
import { effectiveImage, sampleHandImage, updateTableImage, type TableImage } from '../../src/ai/image';
import { tablePositionFor } from '../../src/ai/line';
import { generatePersonality } from '../../src/ai/personality';
import { emptyHeroProfile, summarizePlayerHand, updateHeroProfile } from '../../src/ai/profile';
import type { Personality } from '../../src/ai/types';
import { seeded } from './bots';

const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
const STREETS = ['flop', 'turn', 'river'] as const;
const STACK_BB = 100;

/** Counted rate: opportunities and hits. */
class Rate {
  n = 0;
  hit = 0;
  add(hit: boolean): void {
    this.n++;
    if (hit) this.hit++;
  }
  toString(): string {
    return this.n === 0 ? '—' : `${((100 * this.hit) / this.n).toFixed(1)}%`;
  }
}

/** Counted mix of fold / call / re-raise answers. */
class Answers {
  fold = 0;
  call = 0;
  reraise = 0;
  add(type: string): void {
    if (type === 'fold') this.fold++;
    else if (type === 'call') this.call++;
    else this.reraise++;
  }
  toString(): string {
    const n = this.fold + this.call + this.reraise;
    const pct = (x: number) => `${((100 * x) / Math.max(1, n)).toFixed(1)}%`;
    return n === 0 ? '—' : `${pct(this.fold)} / ${pct(this.call)} / ${pct(this.reraise)} (n=${n})`;
  }
}

interface SeatTally {
  hands: number;
  vpip: number;
  pfr: number;
  postBets: number;
  postCalls: number;
  postBluffs: number;
  net: number;
}

const rates = {
  walk: new Rate(),
  heroBigBlindWalk: new Rate(),
  vpip: new Rate(),
  pfr: new Rate(),
  threeBet: new Rate(),
  foldToThreeBet: new Rate(),
  /** Opens (raise or limp) when folded to the cutoff, button or small blind. */
  stealAttempt: new Rate(),
  /** Small-blind completes when folded to it. */
  sbLimp: new Rate(),
  bbFoldToSteal: new Rate(),
  cbetHeadsUp: new Rate(),
  cbetMultiway: new Rate(),
  foldToCbet: new Rate(),
  flopCheckRaise: new Rate(),
  turnCheckRaise: new Rate(),
  donk: new Rate(),
  turnBarrel: new Rate(),
  riverBet: new Rate(),
  /** River opening bets with two players acting on the river, and with three or more. */
  riverBetHeadsUp: new Rate(),
  riverBetMultiway: new Rate(),
  /** Flops seen by three or more players that reach the river with no bet on any street. */
  multiwayCheckedThrough: new Rate(),
  /** Of those whose flop and turn checked through, the share whose river checks through as well. */
  multiwayRiverCheck: new Rate(),
  sawFlop: new Rate(),
  wentToShowdown: new Rate(),
  wonAtShowdown: new Rate(),
  allInHand: new Rate(),
  /** Post-flop bets and raises the AI itself marks as bluffs. */
  bluffShare: { flop: new Rate(), turn: new Rate(), river: new Rate() },
  /** Shown-down river bets and raises made with less than top pair. */
  riverBetShownWeak: new Rate(),
  /** Post-flop raises of a bet: value (pair or better) and with less than top pair. */
  postflopRaiseWeak: new Rate(),
  /** Answer of a post-flop bettor whose bet gets raised: fold / call / re-raise. */
  raisedBettor: new Answers(),
};

/** Seats folded to before the big blind, by table position: raises and limps (completes). */
const foldedTo: Record<string, { n: number; raise: number; limp: number }> = {};
/** Folded-to small blinds that complete with a hand below their raising range. */
let sbCompletes = 0;
const riverHands = { headsUp: 0, multiway: 0 };

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

/** Less than top pair on the board as it stood on `street` (playing the board counts as nothing). */
function belowTopPair(game: GameState, playerId: number, street: (typeof STREETS)[number]): boolean {
  const player = game.players.find((p) => p.id === playerId);
  if (!player || player.hole.length !== 2) return false;
  const board = game.board.slice(0, street === 'flop' ? 3 : street === 'turn' ? 4 : 5);
  const hole = player.hole as [Card, Card];
  const f = analyseHand(hole, board);
  if (f.category === HandCategory.HighCard) return true;
  if (board.length === 5 && evaluateHand([...hole, ...board]).score === evaluateHand(board).score) return true;
  return f.category === HandCategory.Pair && f.pairKind !== 'top' && f.pairKind !== 'over';
}

/** Tally one finished hand. */
function collect(game: GameState, seatTallies: SeatTally[], bluffs: Map<string, boolean>): void {
  const h = game.history;
  const pre = h.filter((a) => a.street === 'preflop');
  const bb = game.players.findIndex((_, i) => tablePositionFor(game, i) === 'bb');
  const isWalk = game.board.length === 0 && pre.length > 0 && pre.every((a) => a.type === 'fold');
  rates.walk.add(isWalk);
  if (bb >= 0 && game.players[bb].id === 0) rates.heroBigBlindWalk.add(isWalk);
  rates.allInHand.add(h.some((a) => a.type === 'allin'));

  let pfa = -1;
  for (const a of pre) if (AGGRESSIVE.has(a.type)) pfa = a.playerId;
  const flopPlayers = new Set(h.filter((a) => a.street === 'flop').map((a) => a.playerId));
  const position = (id: number) => tablePositionFor(game, game.players.findIndex((p) => p.id === id));

  // Pre-flop: opens when folded to, 3-bets, folds to 3-bets, blind defence.
  let raises = 0;
  let opener = -1;
  let folded = true;
  const seenThreeBetChance = new Set<number>();
  for (const a of pre) {
    const pos = position(a.playerId);
    if (raises === 0 && folded && pos !== 'bb') {
      if (pos === 'co' || pos === 'btn' || pos === 'sb') rates.stealAttempt.add(a.type !== 'fold');
      if (pos === 'sb') rates.sbLimp.add(a.type === 'call');
    }
    if (raises === 1 && a.playerId !== opener && !seenThreeBetChance.has(a.playerId)) {
      seenThreeBetChance.add(a.playerId);
      rates.threeBet.add(AGGRESSIVE.has(a.type));
      const openerPos = position(opener);
      if (pos === 'bb' && folded && (openerPos === 'co' || openerPos === 'btn' || openerPos === 'sb')) {
        rates.bbFoldToSteal.add(a.type === 'fold');
      }
    }
    if (raises === 2 && a.playerId === opener) rates.foldToThreeBet.add(a.type === 'fold');
    if (a.type !== 'fold' && raises === 0) folded = false;
    if (AGGRESSIVE.has(a.type)) {
      raises++;
      if (raises === 1) {
        opener = a.playerId;
        folded = true;
      }
    } else if (a.type === 'call') {
      folded = false;
    }
  }
  for (const a of pre) {
    const pos = position(a.playerId);
    if (pos === 'bb') break;
    const t = (foldedTo[pos] ??= { n: 0, raise: 0, limp: 0 });
    t.n++;
    if (AGGRESSIVE.has(a.type)) {
      t.raise++;
      break;
    }
    if (a.type === 'call') {
      t.limp++;
      break;
    }
  }

  for (const p of game.players) {
    const mine = pre.filter((a) => a.playerId === p.id);
    const vpip = mine.some((a) => AGGRESSIVE.has(a.type) || (a.type === 'call' && a.toCall > 0));
    const pfr = mine.some((a) => AGGRESSIVE.has(a.type));
    rates.vpip.add(vpip);
    rates.pfr.add(pfr);
    const t = seatTallies[p.id];
    t.hands++;
    if (vpip) t.vpip++;
    if (pfr) t.pfr++;
    t.net += p.stack - STACK_BB * BB_CHIPS;
    const sawFlop = flopPlayers.has(p.id);
    rates.sawFlop.add(sawFlop);
    if (!sawFlop) continue;
    const showdown = game.revealed.includes(p.id);
    rates.wentToShowdown.add(showdown);
    if (showdown) rates.wonAtShowdown.add(game.payouts.some((x) => x.playerId === p.id && x.amount > 0));
  }

  for (const street of STREETS) {
    const acts = h.filter((a) => a.street === street);
    let betMade = false;
    let firstBettor = -1;
    let pfaActed = false;
    const checked = new Set<number>();
    const answeredCbet = new Set<number>();
    acts.forEach((a, i) => {
      const t = seatTallies[a.playerId];
      if (AGGRESSIVE.has(a.type)) {
        t.postBets++;
        const bluff = bluffs.get(`${street}:${i}`) ?? false;
        if (bluff) t.postBluffs++;
        rates.bluffShare[street].add(bluff);
        if (a.toCall > 0) rates.postflopRaiseWeak.add(belowTopPair(game, a.playerId, street));
      } else if (a.type === 'call') {
        t.postCalls++;
      }
      if (street === 'flop' && !betMade && a.playerId === pfa) {
        (flopPlayers.size === 2 ? rates.cbetHeadsUp : rates.cbetMultiway).add(AGGRESSIVE.has(a.type));
      }
      if (street === 'flop' && !betMade && !pfaActed && pfa >= 0 && a.playerId !== pfa) {
        rates.donk.add(AGGRESSIVE.has(a.type));
      }
      if (street === 'turn' && !betMade && a.playerId === pfa) {
        const flopBet = h.find((x) => x.street === 'flop' && AGGRESSIVE.has(x.type));
        if (flopBet?.playerId === pfa) rates.turnBarrel.add(AGGRESSIVE.has(a.type));
      }
      if (street === 'river' && !betMade) rates.riverBet.add(AGGRESSIVE.has(a.type));
      if (betMade && checked.has(a.playerId) && a.toCall > 0 && street !== 'river') {
        (street === 'flop' ? rates.flopCheckRaise : rates.turnCheckRaise).add(AGGRESSIVE.has(a.type));
        checked.delete(a.playerId);
      }
      if (street === 'flop' && betMade && firstBettor === pfa && a.playerId !== pfa && a.toCall > 0 && !answeredCbet.has(a.playerId)) {
        answeredCbet.add(a.playerId);
        rates.foldToCbet.add(a.type === 'fold');
      }
      if (a.type === 'check') checked.add(a.playerId);
      if (AGGRESSIVE.has(a.type)) {
        if (!betMade) firstBettor = a.playerId;
        betMade = true;
      }
      if (a.playerId === pfa) pfaActed = true;
    });
    for (const id of new Set(acts.filter((a) => AGGRESSIVE.has(a.type)).map((a) => a.playerId))) {
      const bet = acts.findIndex((a) => a.playerId === id && AGGRESSIVE.has(a.type));
      const raise = acts.findIndex((a, i) => i > bet && a.playerId !== id && AGGRESSIVE.has(a.type));
      if (raise < 0) continue;
      const answer = acts.slice(raise + 1).find((a) => a.playerId === id);
      if (!answer || answer.toCall <= 0) continue;
      rates.raisedBettor.add(answer.type);
    }
  }

  if (flopPlayers.size >= 3) {
    const unbet = (street: string) => !h.some((a) => a.street === street && AGGRESSIVE.has(a.type));
    const reachedRiver = h.some((a) => a.street === 'river');
    rates.multiwayCheckedThrough.add(reachedRiver && unbet('flop') && unbet('turn') && unbet('river'));
    if (reachedRiver && unbet('flop') && unbet('turn')) rates.multiwayRiverCheck.add(unbet('river'));
  }

  const river = h.filter((a) => a.street === 'river');
  const headsUpRiver = new Set(river.map((a) => a.playerId)).size === 2;
  if (river.length > 0) riverHands[headsUpRiver ? 'headsUp' : 'multiway']++;
  for (const a of river) {
    (headsUpRiver ? rates.riverBetHeadsUp : rates.riverBetMultiway).add(AGGRESSIVE.has(a.type));
    if (AGGRESSIVE.has(a.type)) break;
  }
  const lastRiverAggressor = [...river].reverse().find((a) => AGGRESSIVE.has(a.type));
  if (lastRiverAggressor && game.revealed.includes(lastRiverAggressor.playerId)) {
    rates.riverBetShownWeak.add(belowTopPair(game, lastRiverAggressor.playerId, 'river'));
  }
}

function runSession(hands: number, seed: number, seatCount: number, seatTallies: SeatTally[], personalities: Personality[]) {
  const config: GameConfig = { seatCount, blindLevel: 1, startingStackBB: STACK_BB, difficulty: 'hard' };
  let heroProfile = emptyHeroProfile();
  const images: Record<number, TableImage> = {};
  let decisions = 0;
  let ms = 0;
  for (let hand = 0; hand < hands; hand++) {
    const seats: SeatInit[] = Array.from({ length: seatCount }, (_, i) => ({
      id: i,
      name: `P${i}`,
      isHero: i === 0,
      stack: STACK_BB * BB_CHIPS,
    }));
    let game = startHand(config, seats, hand % seatCount, hand + 1, seeded(seed * 1000003 + hand * 7 + 13));
    const bluffCount: Record<number, number> = {};
    const lastBluffStreet: Record<number, GameState['street']> = {};
    const bluffs = new Map<string, boolean>();
    for (let step = 0; game.status === 'betting' && step < 400; step++) {
      const idx = game.toAct;
      if (idx < 0) break;
      const ctx = buildDecisionContext(game, idx, {
        recentImage: effectiveImage(images[idx]),
        bluffCount: bluffCount[idx] ?? 0,
        lastBluffStreet: lastBluffStreet[idx],
      });
      const started = performance.now();
      const decision = decide({
        personality: personalities[idx],
        difficulty: 'hard',
        ctx,
        rng: seeded(decisionSeed(seed, hand, step, 1)),
        heroProfile: game.players[0].folded ? undefined : heroProfile,
      });
      ms += performance.now() - started;
      decisions++;
      if (decision.reason.includes('pf-sb-complete')) sbCompletes++;
      if (game.street !== 'preflop' && (decision.action === 'raise' || decision.action === 'allin')) {
        const index = game.history.filter((a) => a.street === game.street).length;
        bluffs.set(`${game.street}:${index}`, decision.isBluff);
      }
      if (decision.isBluff) {
        bluffCount[idx] = (bluffCount[idx] ?? 0) + 1;
        lastBluffStreet[idx] = game.street;
      }
      game = applyAction(game, { type: decision.action, amount: decision.amount });
    }
    collect(game, seatTallies, bluffs);
    heroProfile = updateHeroProfile(heroProfile, summarizePlayerHand(game, 0));
    for (const p of game.players) images[p.id] = updateTableImage(images[p.id], sampleHandImage(game, p.id));
  }
  return { decisions, ms };
}

const [handsArg = '3000', seedsArg = '4242,777', seatsArg = '6'] = process.argv.slice(2);
const hands = Number(handsArg);
const seeds = seedsArg.split(',').map(Number);
const seatCount = Number(seatsArg);

const started = Date.now();
let decisions = 0;
let ms = 0;
const players: { seed: number; seat: number; p: Personality; t: SeatTally }[] = [];
for (const seed of seeds) {
  const personalities = Array.from({ length: seatCount }, (_, i) => generatePersonality('hard', seeded(seed * 31 + i)));
  const seatTallies = personalities.map(() => ({ hands: 0, vpip: 0, pfr: 0, postBets: 0, postCalls: 0, postBluffs: 0, net: 0 }));
  const run = runSession(hands, seed, seatCount, seatTallies, personalities);
  decisions += run.decisions;
  ms += run.ms;
  personalities.forEach((p, seat) => players.push({ seed, seat, p, t: seatTallies[seat] }));
}

console.log(
  `${seeds.length} seeds x ${hands} hands, ${seatCount} seats, 100bb (${((Date.now() - started) / 1000).toFixed(0)}s, ${(ms / Math.max(1, decisions)).toFixed(1)}ms/decision)`,
);
const rows: [string, string][] = [
  ['Walk (all folds to the big blind)', `${rates.walk}`],
  ['  … with seat 0 (the "human") in the big blind', `${rates.heroBigBlindWalk}`],
  ['VPIP / PFR', `${rates.vpip} / ${rates.pfr}`],
  ['3-bet / fold to 3-bet', `${rates.threeBet} / ${rates.foldToThreeBet}`],
  ['Steal attempt (CO/BTN/SB, folded to)', `${rates.stealAttempt}`],
  ['SB limp when folded to', `${rates.sbLimp}`],
  ['BB fold to a steal', `${rates.bbFoldToSteal}`],
  ['Flop c-bet heads-up / multiway', `${rates.cbetHeadsUp} / ${rates.cbetMultiway}`],
  ['Fold to flop c-bet', `${rates.foldToCbet}`],
  ['Check-raise flop / turn', `${rates.flopCheckRaise} / ${rates.turnCheckRaise}`],
  ['Donk lead', `${rates.donk}`],
  ['Turn barrel after a flop c-bet', `${rates.turnBarrel}`],
  ['River opening bet', `${rates.riverBet}`],
  [
    '  … heads-up / multiway (rivers)',
    `${rates.riverBetHeadsUp} / ${rates.riverBetMultiway} (${riverHands.headsUp} / ${riverHands.multiway})`,
  ],
  ['Multiway flops checked through all streets', `${rates.multiwayCheckedThrough} (n=${rates.multiwayCheckedThrough.n})`],
  ['  … river checked after a checked flop and turn', `${rates.multiwayRiverCheck} (n=${rates.multiwayRiverCheck.n})`],
  ['Bluff share of bets+raises flop / turn / river', `${rates.bluffShare.flop} / ${rates.bluffShare.turn} / ${rates.bluffShare.river}`],
  ['Post-flop raises made with less than top pair', `${rates.postflopRaiseWeak}`],
  ['Raised post-flop bettor: fold / call / re-raise', `${rates.raisedBettor}`],
  ['Shown river bets with less than top pair', `${rates.riverBetShownWeak}`],
  ['Saw flop / WTSD / W$SD', `${rates.sawFlop} / ${rates.wentToShowdown} / ${rates.wonAtShowdown}`],
  ['Hands with an all-in', `${rates.allInHand}`],
];
for (const [label, value] of rows) console.log(`  ${label.padEnd(50)} ${value}`);

console.log('\n  folded to        n   raise   limp   fold');
const order = ['early', 'middle', 'hj', 'co', 'btn', 'sb'];
for (const pos of [...order, ...Object.keys(foldedTo).filter((k) => !order.includes(k))]) {
  const t = foldedTo[pos];
  if (!t) continue;
  const pct = (x: number) => `${((100 * x) / t.n).toFixed(1)}%`.padStart(6);
  console.log(`  ${pos.padEnd(9)} ${String(t.n).padStart(6)}  ${pct(t.raise)} ${pct(t.limp)} ${pct(t.n - t.raise - t.limp)}`);
}
const sbFoldedTo = foldedTo.sb?.n ?? 0;
console.log(`  small blind completes below its raising range: ${((100 * sbCompletes) / Math.max(1, sbFoldedTo)).toFixed(1)}% of folded-to`);

console.log('\n  seed seat   vpip-param  VPIP   PFR    AF    bluffs  bb/100');
for (const { seed, seat, p, t } of players) {
  const pct = (n: number) => `${((100 * n) / Math.max(1, t.hands)).toFixed(1)}%`.padStart(6);
  const af = (t.postBets / Math.max(1, t.postCalls)).toFixed(2).padStart(5);
  const bluffs = `${((100 * t.postBluffs) / Math.max(1, t.postBets)).toFixed(0)}%`.padStart(6);
  const bb100 = ((100 * t.net) / BB_CHIPS / Math.max(1, t.hands)).toFixed(1).padStart(7);
  console.log(`  ${String(seed).padStart(4)} ${String(seat).padStart(4)}   ${p.vpip.toFixed(2).padStart(10)} ${pct(t.vpip)} ${pct(t.pfr)} ${af} ${bluffs} ${bb100}`);
}
