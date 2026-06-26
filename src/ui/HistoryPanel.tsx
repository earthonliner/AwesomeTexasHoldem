import { useState } from 'react';
import type { HandHistoryEntry } from '../store/types';
import type { ActionRecord } from '../engine/gameTypes';
import { PlayingCard } from './PlayingCard';
import { formatBB, formatSigned, formatPercent } from '../utils/format';

const ACTION_LABEL: Record<string, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allin: '全下',
};

const STREET_LABEL: Record<string, string> = {
  preflop: '翻前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  showdown: '摊牌',
};

function actionText(a: ActionRecord, names: Record<number, string>): string {
  const name = names[a.playerId] ?? `P${a.playerId}`;
  const amt = a.amount > 0 ? ` ${formatBB(a.amount)}` : '';
  return `${name} ${ACTION_LABEL[a.type] ?? a.type}${amt}`;
}

export function HistoryPanel({ history }: { history: HandHistoryEntry[] }) {
  const [selected, setSelected] = useState<HandHistoryEntry | null>(null);
  const recent = [...history].reverse().slice(0, 30);

  return (
    <div className="rounded-xl bg-slate-900/70 p-3 ring-1 ring-slate-700">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">🕑 手牌历史 / 回放</h3>
      {recent.length === 0 ? (
        <p className="text-xs text-slate-500">尚无历史记录。</p>
      ) : (
        <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
          {recent.map((h) => (
            <button
              key={h.handNumber}
              onClick={() => setSelected(h)}
              className="flex w-full items-center justify-between rounded bg-slate-800/70 px-2 py-1 text-xs hover:bg-slate-700"
            >
              <span className="text-slate-400">#{h.handNumber}</span>
              <span className="flex gap-0.5">
                {h.heroHole.map((c, i) => (
                  <span key={i} className="font-mono text-slate-200">
                    {rankStr(c.rank)}
                    {suitGlyph(c.suit)}
                  </span>
                ))}
              </span>
              <span className={`font-mono ${h.heroDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {formatSigned(h.heroDelta)}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && <ReplayModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ReplayModal({ entry, onClose }: { entry: HandHistoryEntry; onClose: () => void }) {
  const [step, setStep] = useState(entry.actions.length);
  const visibleActions = entry.actions.slice(0, step);

  // Reconstruct how much board is visible at the given step.
  const streetsSeen = new Set(visibleActions.map((a) => a.street));
  let boardCount = 0;
  if (streetsSeen.has('flop')) boardCount = 3;
  if (streetsSeen.has('turn')) boardCount = 4;
  if (streetsSeen.has('river')) boardCount = 5;
  if (step >= entry.actions.length) boardCount = entry.board.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-slate-900 p-5 ring-1 ring-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">手牌 #{entry.handNumber} 回放</h2>
          <button onClick={onClose} className="rounded bg-slate-700 px-2 py-1 text-sm hover:bg-slate-600">
            关闭
          </button>
        </div>

        <div className="mb-3 flex items-center gap-4">
          <div>
            <div className="mb-1 text-xs text-slate-400">你的手牌</div>
            <div className="flex gap-1">
              {entry.heroHole.map((c, i) => (
                <PlayingCard key={i} card={c} size="md" />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-slate-400">公共牌</div>
            <div className="flex gap-1">
              {entry.board.map((c, i) => (
                <PlayingCard key={i} card={c} faceDown={i >= boardCount} size="md" />
              ))}
              {entry.board.length === 0 && <span className="text-xs text-slate-500">（翻前结束）</span>}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-slate-400">结果</div>
            <div className={`text-xl font-bold ${entry.heroDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {formatSigned(entry.heroDelta)}
            </div>
          </div>
        </div>

        {/* Stepper */}
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
          >
            ◀ 上一步
          </button>
          <input
            type="range"
            min={0}
            max={entry.actions.length}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="flex-1 accent-amber-500"
          />
          <button
            onClick={() => setStep((s) => Math.min(entry.actions.length, s + 1))}
            className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
          >
            下一步 ▶
          </button>
        </div>

        {/* Action log */}
        <div className="mb-4 max-h-40 overflow-y-auto rounded-lg bg-black/30 p-2 text-sm">
          {visibleActions.length === 0 ? (
            <p className="text-slate-500">手牌开始（盲注已下）。</p>
          ) : (
            visibleActions.map((a, i) => (
              <div key={i} className="flex justify-between border-b border-slate-800 py-0.5 last:border-0">
                <span className="text-slate-500">{STREET_LABEL[a.street]}</span>
                <span className="text-slate-200">{actionText(a, entry.seatNames)}</span>
              </div>
            ))
          )}
        </div>

        {/* Decision review */}
        {entry.decisions.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">🔍 决策复盘 (EV 对比)</h3>
            <div className="space-y-2">
              {entry.decisions.map((d, i) => {
                const best = bestChoice(d.evCall, d.evFold, d.evRaiseHint);
                return (
                  <div key={i} className="rounded-lg bg-slate-800/60 p-2 text-xs">
                    <div className="mb-1 flex justify-between text-slate-400">
                      <span>{STREET_LABEL[d.street]} · 胜率 {formatPercent(d.equity)}</span>
                      <span>你的选择: {ACTION_LABEL[d.chosen] ?? d.chosen}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <EvCell label="弃牌" ev={d.evFold} best={best === 'fold'} />
                      <EvCell label="跟注" ev={d.evCall} best={best === 'call'} />
                      <EvCell label="加注≈" ev={d.evRaiseHint} best={best === 'raise'} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function bestChoice(evCall: number, evFold: number, evRaise: number): 'call' | 'fold' | 'raise' {
  const max = Math.max(evCall, evFold, evRaise);
  if (max === evRaise) return 'raise';
  if (max === evCall) return 'call';
  return 'fold';
}

function EvCell({ label, ev, best }: { label: string; ev: number; best: boolean }) {
  return (
    <div className={`rounded p-1 text-center ${best ? 'bg-emerald-700/40 ring-1 ring-emerald-500' : 'bg-slate-900/60'}`}>
      <div className="text-slate-400">{label}</div>
      <div className={`font-mono ${ev >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{formatSigned(ev)}</div>
    </div>
  );
}

function rankStr(r: number): string {
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 10: 'T' }[r] ?? String(r);
}
function suitGlyph(s: string): string {
  return { s: '♠', h: '♥', d: '♦', c: '♣' }[s] ?? s;
}
