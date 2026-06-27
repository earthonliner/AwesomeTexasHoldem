import { useState } from 'react';
import type { DecisionSnapshot } from '../store/types';
import { reviewDecision, VERDICT_META, type Verdict } from '../utils/review';
import { formatBB, formatSigned, formatPercent, bbNum } from '../utils/format';
import { PlayingCard } from './PlayingCard';

const STREET_LABEL: Record<string, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  showdown: '摊牌',
};

const ACTION_LABEL: Record<string, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allin: '全下',
};

/**
 * Inline post-hand review shown when a hand ends (no auto-advance). Lists every
 * hero decision point with the win probability at that moment and a verdict on
 * whether the action was reasonable.
 */
export function HandReviewPanel({
  decisions,
  resultText,
  heroDelta,
  onNext,
}: {
  decisions: DecisionSnapshot[];
  resultText: string;
  heroDelta: number;
  onNext: () => void;
}) {
  const reviews = decisions.map((d) => ({ d, r: reviewDecision(d) }));
  const counts = reviews.reduce(
    (acc, { r }) => {
      acc[r.verdict] += 1;
      return acc;
    },
    { good: 0, ok: 0, bad: 0 } as Record<Verdict, number>,
  );

  return (
    <div className="rounded-xl bg-slate-900/80 p-3 ring-1 ring-amber-600/40">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-amber-300">🧠 本手复盘</h3>
        <button
          onClick={onNext}
          className="rounded-lg bg-gradient-to-r from-emerald-600 to-amber-600 px-4 py-1.5 text-sm font-bold text-white shadow transition hover:brightness-110 active:scale-95"
        >
          下一手 →
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`font-semibold ${heroDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {resultText || '本手结束'} · {formatSigned(heroDelta)}
        </span>
        {decisions.length > 0 && (
          <span className="ml-auto flex gap-2 text-slate-400">
            <Tally verdict="good" n={counts.good} />
            <Tally verdict="ok" n={counts.ok} />
            <Tally verdict="bad" n={counts.bad} />
          </span>
        )}
      </div>

      {decisions.length === 0 ? (
        <p className="text-xs text-slate-500">本手你没有需要决策的行动（如被自动盖牌或直接获胜）。</p>
      ) : (
        <div className="max-h-[30rem] space-y-2 overflow-y-auto pr-1">
          {reviews.map(({ d, r }, i) => (
            <DecisionCard key={i} d={d} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ d, r }: { d: DecisionSnapshot; r: ReturnType<typeof reviewDecision> }) {
  const [showFormula, setShowFormula] = useState(false);
  const meta = VERDICT_META[r.verdict];
  const facingBet = d.toCall > 0;
  // Backward-compat for older saved hands without the new fields.
  const potOdds = d.potOdds ?? (facingBet ? d.toCall / (d.potBefore + d.toCall) : 0);
  const win = d.win ?? d.equity;
  const tie = d.tie ?? 0;
  const rangePct = d.rangeFraction ? Math.round(d.rangeFraction * 100) : null;

  return (
    <div className="rounded-lg bg-slate-800/60 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-2 text-slate-300">
          <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
          <span className="font-semibold">{STREET_LABEL[d.street]}</span>
          <span className="text-slate-500">底池 {formatBB(d.potBefore)}</span>
          {facingBet && <span className="text-amber-400">需跟 {formatBB(d.toCall)}</span>}
        </span>
        <span className={`font-semibold ${meta.cls}`}>{meta.label}</span>
      </div>

      {d.board.length > 0 && (
        <div className="mb-1 flex gap-1">
          {d.board.map((c, j) => (
            <PlayingCard key={j} card={c} size="sm" />
          ))}
        </div>
      )}

      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-400">
        <span>
          胜率 <span className="font-mono text-amber-300">{formatPercent(d.equity)}</span>
        </span>
        {facingBet && (
          <span>
            底池赔率 <span className="font-mono text-sky-300">{formatPercent(potOdds)}</span>
          </span>
        )}
        <span>
          你的选择 <span className="text-slate-200">{ACTION_LABEL[d.chosen] ?? d.chosen}</span>
        </span>
      </div>

      <div className="mb-1 grid grid-cols-3 gap-1">
        <EvCell label="弃牌" ev={d.evFold} best={r.bestAction === 'fold'} />
        <EvCell label="跟注" ev={d.evCall} best={r.bestAction === 'call'} />
        <EvCell label="加注≈" ev={d.evRaiseHint} best={r.bestAction === 'raise'} />
      </div>

      <p className="mb-1 text-slate-400">{r.comment}</p>

      {r.commitRatio > 0 && (
        <div className="mb-1 text-slate-500">
          本次投入占筹码{' '}
          <span className={`font-mono ${r.commitRatio >= 0.5 ? 'text-amber-300' : 'text-slate-300'}`}>
            {Math.round(r.commitRatio * 100)}%
          </span>
        </div>
      )}

      {r.riskNote && (
        <div className="mb-1 rounded border-l-4 border-rose-500 bg-rose-900/20 px-2 py-1.5 text-[11px] leading-relaxed text-rose-100">
          ⚠️ 风险提示：{r.riskNote}
        </div>
      )}

      <button onClick={() => setShowFormula((v) => !v)} className="text-[11px] text-sky-400 hover:underline">
        {showFormula ? '收起公式 ▲' : '查看计算公式 ▼'}
      </button>

      {showFormula && (
        <div className="mt-1 space-y-1 rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
          <div className="font-sans text-slate-400">胜率（蒙特卡洛模拟）：</div>
          <div>
            模拟 {d.iterations ?? '—'} 局，对手按
            {rangePct !== null ? `「当前牌面前 ${rangePct}% 强手牌」` : '估计范围'}
            取样{d.liveOpponents ? ` × ${d.liveOpponents} 名对手` : ''}。
          </div>
          <div>
            胜率 = 胜局 / 总局 = {formatPercent(win)}
            {tie > 0 ? `（平局 ${formatPercent(tie)}，按分摊计入）` : ''}
          </div>
          <div>综合权益 = (胜局 + 平局/平分人数) / 总局 = {formatPercent(d.equity)}</div>

          {facingBet && (
            <>
              <div className="pt-1 font-sans text-slate-400">底池赔率：</div>
              <div>
                底池赔率 = 跟注 ÷ (底池 + 跟注) = {bbNum(d.toCall)} ÷ ({bbNum(d.potBefore)} + {bbNum(d.toCall)}) ={' '}
                {formatPercent(potOdds)}
              </div>
              <div className={d.equity >= potOdds ? 'text-emerald-300' : 'text-rose-300'}>
                跟注所需最低胜率 = 底池赔率 = {formatPercent(potOdds)}；你的权益 {formatPercent(d.equity)}{' '}
                {d.equity >= potOdds ? '≥ 所需 → 跟注 +EV' : '< 所需 → 跟注 -EV'}
              </div>
              <div className="font-sans text-slate-500">
                跟注 EV = 权益 × (底池 + 跟注) − (1 − 权益) × 跟注 = {formatSigned(d.evCall)}
              </div>
            </>
          )}
          {!facingBet && (
            <div className="font-sans text-slate-500">无人下注，可免费过牌看牌（无需支付底池赔率）。</div>
          )}
        </div>
      )}
    </div>
  );
}

function Tally({ verdict, n }: { verdict: Verdict; n: number }) {
  const meta = VERDICT_META[verdict];
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
      <span className={meta.cls}>{n}</span>
    </span>
  );
}

function EvCell({ label, ev, best }: { label: string; ev: number; best: boolean }) {
  return (
    <div className={`rounded p-1 text-center ${best ? 'bg-emerald-700/40 ring-1 ring-emerald-500' : 'bg-slate-900/60'}`}>
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={`font-mono ${ev >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{formatSigned(ev)}</div>
    </div>
  );
}
