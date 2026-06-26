import type { GameState } from '../engine/gameTypes';
import type { OpponentStat } from '../store/types';
import { Seat } from './Seat';
import { CommunityCards } from './CommunityCards';
import { seatPositions } from '../utils/seats';
import { totalPot } from '../engine/game';
import { formatBB } from '../utils/format';

interface Props {
  game: GameState;
  thinkingId: number | null;
  showHud: boolean;
  opponentStats: Record<number, OpponentStat>;
  resultText: string;
  handOver: boolean;
}

function positionLabel(game: GameState, idx: number): string {
  const n = game.players.length;
  const dist = (idx - game.buttonIndex + n) % n;
  if (dist === 0) return 'BTN';
  if (dist === 1) return 'SB';
  if (dist === 2) return 'BB';
  return '';
}

export function PokerTable({ game, thinkingId, showHud, opponentStats, resultText, handOver }: Props) {
  const positions = seatPositions(game.players.length);
  const pot = totalPot(game);

  return (
    <div className="relative mx-auto aspect-[16/10] w-full max-w-5xl">
      {/* Felt */}
      <div className="absolute inset-[6%] rounded-[48%] border-8 border-amber-950/70 bg-felt shadow-[inset_0_0_80px_rgba(0,0,0,0.6)]">
        <div className="absolute inset-4 rounded-[48%] border border-white/10" />
      </div>

      {/* Center: board + pot */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
        <div className="rounded-full bg-black/40 px-4 py-1 font-mono text-sm text-amber-200 ring-1 ring-amber-500/30">
          底池 {formatBB(pot)}
        </div>
        <CommunityCards board={game.board} />
        {handOver && resultText && (
          <div className="mt-1 animate-dealIn rounded-lg bg-black/70 px-4 py-1.5 text-center text-sm font-semibold text-yellow-200 shadow-lg">
            {resultText}
          </div>
        )}
      </div>

      {/* Seats */}
      {game.players.map((player, idx) => {
        const pos = positions[idx];
        return (
          <div
            key={player.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
          >
            <Seat
              player={player}
              isButton={idx === game.buttonIndex}
              isActive={game.toAct === idx && !handOver}
              isThinking={thinkingId === player.id}
              revealed={game.revealed.includes(player.id)}
              showHud={showHud}
              hudStat={opponentStats[player.id]}
              positionLabel={positionLabel(game, idx)}
            />
          </div>
        );
      })}
    </div>
  );
}
