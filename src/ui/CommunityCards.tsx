import type { Card } from '../engine/types';
import { PlayingCard } from './PlayingCard';

export function CommunityCards({ board }: { board: Card[] }) {
  const slots = Array.from({ length: 5 }, (_, i) => board[i] ?? null);
  return (
    <div className="community-cards flex gap-2">
      {slots.map((c, i) =>
        c ? (
          <PlayingCard key={i} card={c} size="lg" dealt />
        ) : (
          <div key={i} className="community-card-slot h-24 w-[4.5rem] rounded-xl border border-white/10 bg-black/20" />
        ),
      )}
    </div>
  );
}
