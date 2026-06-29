import type { PlayerState } from '../engine/gameTypes';
import type { OpponentStat } from '../store/types';
import { PlayingCard } from './PlayingCard';
import { formatBB, formatSigned } from '../utils/format';

interface Props {
  player: PlayerState;
  isButton: boolean;
  isActive: boolean;
  isThinking: boolean;
  revealed: boolean;
  showHud: boolean;
  hudStat?: OpponentStat;
  positionLabel?: string;
  /** Table-lifetime net profit/loss (chips), independent of rebuys. */
  net?: number;
}

function statusBadge(player: PlayerState): { text: string; cls: string } | null {
  if (player.sittingOut) return { text: '离场', cls: 'bg-slate-600' };
  if (player.folded) return { text: '弃牌', cls: 'bg-slate-700 text-slate-300' };
  if (player.allIn) return { text: '全下', cls: 'bg-rose-600' };
  if (player.lastAction === 'check') return { text: '过牌', cls: 'bg-sky-700' };
  if (player.lastAction === 'call') return { text: '跟注', cls: 'bg-emerald-700' };
  if (player.lastAction === 'bet') return { text: '下注', cls: 'bg-amber-600' };
  if (player.lastAction === 'raise') return { text: '加注', cls: 'bg-amber-600' };
  return null;
}

export function Seat({ player, isButton, isActive, isThinking, revealed, showHud, hudStat, positionLabel, net }: Props) {
  const badge = statusBadge(player);
  const dimmed = player.folded || player.sittingOut;
  const showCards = player.isHero || revealed;

  return (
    <div className={`relative flex w-32 flex-col items-center ${dimmed ? 'opacity-50' : ''}`}>
      {/* Hole cards */}
      <div className="mb-1 flex gap-1">
        {player.hole.length > 0 ? (
          player.hole.map((c, i) => (
            <PlayingCard key={i} card={showCards ? c : null} faceDown={!showCards} size={player.isHero ? 'md' : 'sm'} />
          ))
        ) : (
          <div className="h-12" />
        )}
      </div>

      <div
        className={`w-full rounded-xl border px-2 py-1 text-center shadow-lg transition ${
          isActive
            ? 'border-yellow-400 bg-slate-800/95 animate-pulseRing'
            : 'border-slate-700 bg-slate-800/80'
        }`}
      >
        <div className="flex items-center justify-center gap-1 text-sm font-semibold text-slate-100">
          {player.isHero && <span className="text-emerald-400">★</span>}
          <span className="truncate">{player.name}</span>
        </div>
        <div className="font-mono text-sm text-yellow-300">{formatBB(player.stack)}</div>
        {net !== undefined && (
          <div
            className={`text-[10px] font-mono ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-rose-400' : 'text-slate-500'}`}
            title="本桌历史盈亏（不含补码）"
          >
            盈亏 {formatSigned(net)}
          </div>
        )}
        {isThinking && <div className="text-xs text-sky-300">思考中…</div>}
      </div>

      {/* Bet chips committed this street */}
      {player.streetCommitted > 0 && !player.folded && (
        <div className="mt-1 animate-chipMove rounded-full bg-slate-900/80 px-2 py-0.5 font-mono text-xs text-amber-300 ring-1 ring-amber-500/40">
          {formatBB(player.streetCommitted)}
        </div>
      )}

      {badge && (
        <div className={`absolute -top-1 right-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${badge.cls}`}>
          {badge.text}
        </div>
      )}

      {isButton && (
        <div className="absolute -bottom-2 left-1 flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-bold text-slate-900 shadow">
          D
        </div>
      )}

      {positionLabel && (
        <div className="absolute -bottom-2 right-1 rounded bg-slate-700 px-1 text-[10px] text-slate-300">{positionLabel}</div>
      )}

      {showHud && hudStat && hudStat.hands > 0 && (
        <div className="absolute -left-2 top-8 w-20 rounded bg-black/80 p-1 text-[10px] leading-tight text-slate-200 ring-1 ring-fuchsia-500/40">
          <div>手数 {hudStat.hands}</div>
          <div>VPIP {(hudStat.vpip * 100).toFixed(0)}%</div>
          <div>PFR {(hudStat.pfr * 100).toFixed(0)}%</div>
          <div>AGG {(hudStat.aggression * 100).toFixed(0)}%</div>
        </div>
      )}
    </div>
  );
}
