import type { Stats } from '../store/types';
import { formatSigned, formatBB } from '../utils/format';

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="h-16 text-xs text-slate-500">数据不足，先打几手。</div>;
  const w = 240;
  const h = 64;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = h - ((0 - min) / range) * h;
  const last = data[data.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full">
      <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="rgba(148,163,184,0.3)" strokeDasharray="3 3" />
      <polyline points={points} fill="none" stroke={last >= 0 ? '#34d399' : '#fb7185'} strokeWidth={2} />
    </svg>
  );
}

export function StatsPanel({ stats, onReset }: { stats: Stats; onReset: () => void }) {
  const wsdr = stats.showdownsSeen > 0 ? (stats.showdownsWon / stats.showdownsSeen) * 100 : 0;
  const winRate = stats.handsPlayed > 0 ? (stats.handsWon / stats.handsPlayed) * 100 : 0;
  const bbPer100 = stats.handsPlayed > 0 ? (stats.netChips / 2 / stats.handsPlayed) * 100 : 0;

  return (
    <div className="rounded-xl bg-slate-900/70 p-3 ring-1 ring-slate-700">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">📈 盈亏统计</h3>
        <button onClick={onReset} className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-600">
          重置
        </button>
      </div>
      <div className={`text-2xl font-bold ${stats.netChips >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        {formatSigned(stats.netChips)}
      </div>
      <Sparkline data={stats.profitCurve} />
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-300">
        <Stat label="总手数" value={`${stats.handsPlayed}`} />
        <Stat label="胜率" value={`${winRate.toFixed(1)}%`} />
        <Stat label="BB/100" value={bbPer100.toFixed(1)} />
        <Stat label="摊牌胜率" value={`${wsdr.toFixed(0)}%`} />
        <Stat label="最大彩池" value={formatBB(stats.biggestPotWon)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-200">{value}</span>
    </div>
  );
}
