import type { GameState } from '../engine/gameTypes';
import type { Card } from '../engine/types';

// A placeholder card for hidden opponent holdings. Its value is never shown
// (the UI renders a card back for non-revealed opponents); we only preserve the
// count so two face-down cards are drawn.
const HIDDEN_CARD: Card = { rank: 2, suit: 's' };

/**
 * Produce a per-viewer redacted copy of the game state safe to send to a client:
 *  - the deck is stripped entirely (clients must never see undealt cards),
 *  - only the viewer's (and revealed showdown) hole cards are real; everyone
 *    else's are replaced with hidden placeholders of the same count,
 *  - the viewer's seat is flagged `isHero` so existing UI/analysis just works.
 */
export function redactGameStateFor(state: GameState, viewerSeatId: number): GameState {
  return {
    ...state,
    deck: [],
    players: state.players.map((p) => {
      const reveal = p.id === viewerSeatId || state.revealed.includes(p.id);
      const hole = reveal ? p.hole.map((c) => ({ ...c })) : p.hole.map(() => ({ ...HIDDEN_CARD }));
      return { ...p, isHero: p.id === viewerSeatId, hole };
    }),
    board: state.board.map((c) => ({ ...c })),
    pots: state.pots.map((pp) => ({ ...pp, eligible: [...pp.eligible] })),
    payouts: state.payouts.map((pp) => ({ ...pp })),
    history: [...state.history],
    revealed: [...state.revealed],
  };
}
