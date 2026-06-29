import { useState } from 'react';
import type { HeroAnalysis } from '../utils/analysis';
import { formatBB, formatPercent, formatSigned } from '../utils/format';

interface Props {
  analysis: HeroAnalysis | null;
  isHeroTurn: boolean;
}

/**
 * Objective math reference. Hidden by default; the player must opt in by clicking
 * "参考" so it stays a deliberate study aid rather than an always-on crutch.
 */
export function MathPanel({ analysis, isHeroTurn }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl bg-slate-900/70 p-3 ring-1 ring-slate-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-slate-200"
      >
        <span>📊 数学参考 (客观数据)</span>
        <span className="rounded bg-slate-700 px-2 py-0.5 text-xs">{open ? '隐藏' : '参考'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2 text-sm">
          {!analysis || !isHeroTurn ? (
            <p className="text-slate-500">轮到你行动时显示实时数据。</p>
          ) : (
            <>
              <Row
                label={`实时胜率 (vs 估计范围·前${Math.round(analysis.rangeFraction * 100)}%${analysis.bluffShare > 0 ? `+诈唬${Math.round(analysis.bluffShare * 100)}%` : ''})`}
                value={formatPercent(analysis.equity)}
                highlight
              />
              <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-amber-400" style={{ width: `${analysis.equity * 100}%` }} />
              </div>
              <Row label="胜 / 平" value={`${formatPercent(analysis.win)} / ${formatPercent(analysis.tie)}`} />
              {analysis.madeHand && <Row label="当前成牌" value={analysis.madeHand} />}
              {analysis.outs > 0 && (
                <>
                  <Row label="补牌 (outs)" value={`${analysis.outs} 张`} />
                  <Row label="转牌命中" value={formatPercent(analysis.hitTurn)} />
                  <Row label="到河牌命中" value={formatPercent(analysis.hitByRiver)} />
                </>
              )}
              {analysis.callAmount > 0 && (
                <>
                  <Row label="底池赔率 (所需胜率)" value={formatPercent(analysis.potOdds)} />
                  <Row
                    label="跟注 EV"
                    value={formatSigned(analysis.callEV)}
                    valueClass={analysis.callEV >= 0 ? 'text-emerald-400' : 'text-rose-400'}
                  />
                  <p className="text-xs text-slate-500">
                    {analysis.equity >= analysis.potOdds
                      ? `胜率 ${formatPercent(analysis.equity)} ≥ 底池赔率，跟注有利可图。`
                      : `胜率低于底池赔率，需考虑隐含赔率或弃牌。`}
                  </p>
                </>
              )}
              {analysis.callAmount === 0 && <Row label="可过牌" value={`底池 ${formatBB(analysis.potBefore)}`} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
  valueClass,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${valueClass ?? (highlight ? 'text-amber-300' : 'text-slate-100')}`}>{value}</span>
    </div>
  );
}
