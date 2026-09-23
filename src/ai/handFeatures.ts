import { evaluateHand } from '../engine/handEvaluator';
import { HandCategory, type Card, type Rank, type Suit } from '../engine/types';

export interface HandFeatures {
  category: HandCategory;
  pairKind: 'none' | 'under' | 'bottom' | 'middle' | 'top' | 'over';
  flushDraw: boolean;
  nutFlushDraw: boolean;
  straightDraw: boolean;
  openEnded: boolean;
  comboDraw: boolean;
  overcards: number;
  drawOutsApprox: number;
  blockerScore: number;
  showdownValue: number;
  bluffQuality: number;
}

const STRAIGHT_WINDOWS: Rank[][] = [
  [14, 5, 4, 3, 2],
  [6, 5, 4, 3, 2],
  [7, 6, 5, 4, 3],
  [8, 7, 6, 5, 4],
  [9, 8, 7, 6, 5],
  [10, 9, 8, 7, 6],
  [11, 10, 9, 8, 7],
  [12, 11, 10, 9, 8],
  [13, 12, 11, 10, 9],
  [14, 13, 12, 11, 10],
];

function bestStraightHigh(ranks: ReadonlySet<Rank>): number {
  let best = 0;
  for (const window of STRAIGHT_WINDOWS) {
    if (!window.every((rank) => ranks.has(rank))) continue;
    const high = window[0] === 14 && window[1] === 5 ? 5 : window[0];
    best = Math.max(best, high);
  }
  return best;
}

function straightCompletionRanks(hole: [Card, Card], board: Card[]): Set<Rank> {
  const playerRanks = new Set([...hole, ...board].map((c) => c.rank));
  const candidates = new Set<Rank>();
  for (const window of STRAIGHT_WINDOWS) {
    const absent = window.filter((rank) => !playerRanks.has(rank));
    if (absent.length === 1) candidates.add(absent[0]);
  }
  const boardRanks = new Set(board.map((card) => card.rank));
  return new Set(
    [...candidates].filter((candidate) => {
      const heroAfter = new Set(playerRanks);
      heroAfter.add(candidate);
      const boardAfter = new Set(boardRanks);
      boardAfter.add(candidate);
      return bestStraightHigh(heroAfter) > bestStraightHigh(boardAfter);
    }),
  );
}

function pairKind(hole: [Card, Card], board: Card[], pairRank?: Rank): HandFeatures['pairKind'] {
  if (pairRank === undefined) return 'none';
  const boardRanks = [...new Set(board.map((c) => c.rank))].sort((a, b) => b - a);
  const holePair = hole[0].rank === hole[1].rank;
  if (holePair && hole[0].rank > Math.max(...boardRanks)) return 'over';
  if (!hole.some((c) => c.rank === pairRank)) return 'under'; // board pair only
  if (pairRank === boardRanks[0]) return 'top';
  if (pairRank === boardRanks[boardRanks.length - 1]) return 'bottom';
  return 'middle';
}

function suitCounts(cards: Card[]): Map<Suit, number> {
  const counts = new Map<Suit, number>();
  for (const card of cards) counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1);
  return counts;
}

/** Board-aware made-hand, draw and blocker features for action selection. */
export function analyseHand(hole: [Card, Card], board: Card[]): HandFeatures {
  const cards = [...hole, ...board];
  const made = evaluateHand(cards);
  const counts = suitCounts(cards);
  const drawSuit = board.length < 5
    ? ([...counts.entries()].find(([, count]) => count === 4)?.[0] ?? null)
    : null;
  const flushDraw = drawSuit !== null && hole.some((c) => c.suit === drawSuit);
  const highestDrawCard = drawSuit
    ? Math.max(0, ...hole.filter((c) => c.suit === drawSuit).map((c) => c.rank))
    : 0;
  const nutFlushDraw = flushDraw && highestDrawCard === 14;

  const completionRanks =
    board.length < 5 ? straightCompletionRanks(hole, board) : new Set<Rank>();
  const straightDraw = completionRanks.size > 0 && made.category < HandCategory.Straight;
  const openEnded = completionRanks.size >= 2;
  const comboDraw = flushDraw && straightDraw;
  const overcards = hole.filter((c) => c.rank > Math.max(...board.map((b) => b.rank))).length;

  let blockerScore = 0;
  const boardSuits = suitCounts(board);
  for (const [suit, count] of boardSuits) {
    if (count >= 3) {
      if (hole.some((c) => c.suit === suit && c.rank === 14)) blockerScore += 0.55;
      else if (hole.some((c) => c.suit === suit && c.rank === 13)) blockerScore += 0.3;
    }
  }
  const boardRankCounts = new Map<Rank, number>();
  for (const card of board) boardRankCounts.set(card.rank, (boardRankCounts.get(card.rank) ?? 0) + 1);
  for (const [rank, count] of boardRankCounts) {
    if (count >= 2 && hole.some((c) => c.rank === rank)) blockerScore += 0.25;
  }
  if (hole.some((c) => c.rank === 14)) blockerScore += 0.08;
  blockerScore = Math.min(1, blockerScore);

  const kind = pairKind(
    hole,
    board,
    made.category === HandCategory.Pair ? made.tiebreakers[0] : undefined,
  );
  let showdownValue = made.category / HandCategory.StraightFlush;
  if (made.category === HandCategory.Pair) {
    showdownValue =
      kind === 'over' ? 0.58 : kind === 'top' ? 0.5 : kind === 'middle' ? 0.38 : 0.3;
  } else if (made.category === HandCategory.HighCard) {
    showdownValue = hole.some((c) => c.rank === 14) ? 0.16 : 0.06;
  }

  let bluffQuality = blockerScore * (board.length === 5 ? 0.75 : 0.25);
  if (flushDraw) bluffQuality += nutFlushDraw ? 0.45 : 0.32;
  if (straightDraw) bluffQuality += openEnded ? 0.35 : 0.2;
  if (comboDraw) bluffQuality += 0.18;
  bluffQuality += overcards * 0.06;
  bluffQuality -= showdownValue * (board.length === 5 ? 0.55 : 0.25);
  bluffQuality = Math.min(1, Math.max(0, bluffQuality));

  const drawOutsApprox =
    (flushDraw ? 9 : 0) +
    (straightDraw ? (openEnded ? 8 : 4) : 0) +
    (overcards > 0 && made.category === HandCategory.HighCard ? overcards * 3 : 0);

  return {
    category: made.category,
    pairKind: kind,
    flushDraw,
    nutFlushDraw,
    straightDraw,
    openEnded,
    comboDraw,
    overcards,
    drawOutsApprox: Math.min(15, drawOutsApprox),
    blockerScore,
    showdownValue,
    bluffQuality,
  };
}
