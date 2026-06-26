import { useEffect, useMemo, useState } from 'react';
import type { GameState } from '../engine/gameTypes';
import { getLegalActions, totalPot } from '../engine/game';
import { formatBB } from '../utils/format';
import { BB_CHIPS } from '../engine/gameTypes';

interface Props {
  game: GameState;
  onAct: (action: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin'; amount: number }) => void;
}

export function ActionBar({ game, onAct }: Props) {
  const heroIdx = game.players.findIndex((p) => p.isHero);
  const hero = game.players[heroIdx];
  const isHeroTurn = game.toAct === heroIdx && game.status === 'betting';

  const legal = useMemo(() => (isHeroTurn ? getLegalActions(game, heroIdx) : null), [game, heroIdx, isHeroTurn]);

  const [raiseTo, setRaiseTo] = useState(0);
  const [confirmAllIn, setConfirmAllIn] = useState(false);

  const pot = totalPot(game);
  const toCall = legal?.callAmount ?? 0;
  const currentLevel = hero ? hero.streetCommitted + toCall : 0;

  useEffect(() => {
    if (legal) setRaiseTo(legal.minRaiseTo);
    setConfirmAllIn(false);
  }, [legal, game.toAct, game.street]);

  const setFractionOfPot = (fraction: number) => {
    if (!legal) return;
    const potAfterCall = pot + toCall;
    const target = currentLevel + Math.round(potAfterCall * fraction);
    setRaiseTo(Math.min(Math.max(target, legal.minRaiseTo), legal.maxRaiseTo));
  };

  const doFold = () => onAct({ type: 'fold', amount: 0 });
  const doCheckCall = () => {
    if (!legal) return;
    onAct(legal.canCheck ? { type: 'check', amount: 0 } : { type: 'call', amount: 0 });
  };
  const doRaise = () => {
    if (!legal) return;
    if (raiseTo >= legal.maxRaiseTo) {
      if (!confirmAllIn) {
        setConfirmAllIn(true);
        return;
      }
      onAct({ type: 'allin', amount: legal.maxRaiseTo });
      return;
    }
    onAct({ type: 'raise', amount: raiseTo });
  };
  const doAllIn = () => {
    if (!legal) return;
    if (!confirmAllIn) {
      setConfirmAllIn(true);
      return;
    }
    onAct({ type: 'allin', amount: legal.maxRaiseTo });
  };

  useEffect(() => {
    if (!isHeroTurn || !legal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      switch (e.key.toLowerCase()) {
        case 'f':
          doFold();
          break;
        case 'c':
          doCheckCall();
          break;
        case 'r':
          if (legal.canBet || legal.canRaise) doRaise();
          break;
        case 'a':
          if (legal.canBet || legal.canRaise) doAllIn();
          break;
        case 'arrowup':
          setRaiseTo((v) => Math.min(legal.maxRaiseTo, v + BB_CHIPS));
          e.preventDefault();
          break;
        case 'arrowdown':
          setRaiseTo((v) => Math.max(legal.minRaiseTo, v - BB_CHIPS));
          e.preventDefault();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeroTurn, legal, raiseTo, confirmAllIn]);

  if (!isHeroTurn || !legal || !hero) {
    return (
      <div className="flex h-28 items-center justify-center rounded-xl bg-slate-900/60 text-slate-400">
        {game.status === 'complete' ? '本手结束，准备下一手…' : '等待其他玩家行动…'}
      </div>
    );
  }

  const canAggress = legal.canBet || legal.canRaise;
  const isAllInRaise = raiseTo >= legal.maxRaiseTo;

  return (
    <div className="rounded-xl bg-slate-900/80 p-3 shadow-lg ring-1 ring-slate-700">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>底池 {formatBB(pot)}</span>
        {toCall > 0 && <span className="text-amber-300">需跟 {formatBB(toCall)}</span>}
        <span className="ml-auto text-slate-500">快捷键: F 弃 / C 过·跟 / R 加 / A 全下 / ↑↓ 调整</span>
      </div>

      {canAggress && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-2">
            <input
              type="range"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              step={1}
              value={raiseTo}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
              className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700 accent-amber-500"
            />
            <span className="w-24 text-right font-mono text-sm text-amber-300">{formatBB(raiseTo)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <QuickBtn label="1/2 池" onClick={() => setFractionOfPot(0.5)} />
            <QuickBtn label="3/4 池" onClick={() => setFractionOfPot(0.75)} />
            <QuickBtn label="底池" onClick={() => setFractionOfPot(1)} />
            <QuickBtn label="2x 池" onClick={() => setFractionOfPot(2)} />
            <QuickBtn label="最小" onClick={() => setRaiseTo(legal.minRaiseTo)} />
            <QuickBtn label="全下" onClick={() => setRaiseTo(legal.maxRaiseTo)} />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={doFold}
          className="flex-1 rounded-lg bg-rose-700 py-3 font-semibold text-white transition hover:bg-rose-600 active:scale-95"
        >
          弃牌 <span className="opacity-60">(F)</span>
        </button>
        <button
          onClick={doCheckCall}
          className="flex-1 rounded-lg bg-emerald-700 py-3 font-semibold text-white transition hover:bg-emerald-600 active:scale-95"
        >
          {legal.canCheck ? '过牌' : `跟注 ${formatBB(toCall)}`} <span className="opacity-60">(C)</span>
        </button>
        {canAggress && (
          <button
            onClick={doRaise}
            className={`flex-1 rounded-lg py-3 font-semibold text-white transition active:scale-95 ${
              confirmAllIn && isAllInRaise ? 'animate-pulse bg-red-600' : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {confirmAllIn && isAllInRaise
              ? '确认全下?'
              : isAllInRaise
                ? `全下 ${formatBB(legal.maxRaiseTo)}`
                : `${legal.canCheck ? '下注' : '加注至'} ${formatBB(raiseTo)}`}{' '}
            <span className="opacity-60">(R)</span>
          </button>
        )}
      </div>
    </div>
  );
}

function QuickBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md bg-slate-700 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-slate-600 active:scale-95"
    >
      {label}
    </button>
  );
}
