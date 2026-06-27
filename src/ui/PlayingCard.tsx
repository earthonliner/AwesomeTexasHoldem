import type { Card, Suit } from '../engine/types';

const RANK_LABEL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const SUIT_GLYPH: Record<Suit, string> = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };

// Traditional two-color deck: spades & clubs black, hearts & diamonds red.
const SUIT_COLOR: Record<Suit, string> = {
  s: 'text-slate-900',
  h: 'text-red-600',
  d: 'text-red-600',
  c: 'text-slate-900',
};

const SIZES = {
  sm: 'h-12 w-9 text-sm rounded-md',
  md: 'h-16 w-12 text-base rounded-lg',
  lg: 'h-24 w-[4.5rem] text-2xl rounded-xl',
};

interface Props {
  card?: Card | null;
  faceDown?: boolean;
  size?: keyof typeof SIZES;
  dealt?: boolean;
  className?: string;
}

export function PlayingCard({ card, faceDown, size = 'md', dealt, className = '' }: Props) {
  const sizeClass = SIZES[size];

  if (faceDown || !card) {
    return (
      <div
        className={`${sizeClass} ${dealt ? 'animate-dealIn' : ''} flex items-center justify-center border border-blue-900/60 bg-gradient-to-br from-blue-700 to-blue-900 shadow-md ${className}`}
        aria-label="暗牌"
      >
        <div className="h-3/4 w-3/4 rounded-md border border-blue-400/40 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.08)_0,rgba(255,255,255,0.08)_3px,transparent_3px,transparent_6px)]" />
      </div>
    );
  }

  const color = SUIT_COLOR[card.suit];
  return (
    <div
      className={`${sizeClass} ${dealt ? 'animate-flipIn' : ''} relative flex flex-col justify-between bg-white p-1 font-semibold shadow-lg ring-1 ring-black/10 ${className}`}
      aria-label={`${RANK_LABEL[card.rank]}${SUIT_GLYPH[card.suit]}`}
    >
      <div className={`flex items-center gap-0.5 leading-none ${color}`}>
        <span>{RANK_LABEL[card.rank]}</span>
        <span>{SUIT_GLYPH[card.suit]}</span>
      </div>
      <div className={`self-center text-2xl leading-none ${color}`}>{SUIT_GLYPH[card.suit]}</div>
      <div className={`flex rotate-180 items-center gap-0.5 self-end leading-none ${color}`}>
        <span>{RANK_LABEL[card.rank]}</span>
        <span>{SUIT_GLYPH[card.suit]}</span>
      </div>
    </div>
  );
}
