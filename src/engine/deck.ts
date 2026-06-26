import type { Card, Rank, Suit } from './types';

export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_LABEL: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const LABEL_RANK: Record<string, Rank> = Object.entries(RANK_LABEL).reduce(
  (acc, [rank, label]) => {
    acc[label] = Number(rank) as Rank;
    return acc;
  },
  {} as Record<string, Rank>,
);

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** Source of randomness so tests can inject deterministic generators. */
export type Rng = () => number;

export const defaultRng: Rng = Math.random;

/** Fisher-Yates shuffle. Mutates and returns the same array for convenience. */
export function shuffle<T>(arr: T[], rng: Rng = defaultRng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cardToString(card: Card): string {
  return `${RANK_LABEL[card.rank]}${card.suit}`;
}

export function cardsToString(cards: Card[]): string {
  return cards.map(cardToString).join(' ');
}

/** Parse compact notation like "As" / "Td" into a Card. Throws on malformed input. */
export function parseCard(str: string): Card {
  const trimmed = str.trim();
  if (trimmed.length < 2) throw new Error(`Invalid card: ${str}`);
  const rankPart = trimmed.slice(0, trimmed.length - 1).toUpperCase();
  const suitPart = trimmed.slice(-1).toLowerCase() as Suit;
  const rank = LABEL_RANK[rankPart];
  if (rank === undefined) throw new Error(`Invalid rank in card: ${str}`);
  if (!SUITS.includes(suitPart)) throw new Error(`Invalid suit in card: ${str}`);
  return { rank, suit: suitPart };
}

export function parseCards(str: string): Card[] {
  return str
    .split(/\s+/)
    .filter(Boolean)
    .map(parseCard);
}

export function cardId(card: Card): number {
  return (card.rank - 2) * 4 + SUITS.indexOf(card.suit);
}
