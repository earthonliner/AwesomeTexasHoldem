import { useEffect, useMemo, useState } from 'react';
import type { RoomView } from '../../online/protocol';
import { useOnlineStore } from '../../online/useOnlineStore';
import { PokerTable } from '../PokerTable';
import { ActionBar } from '../ActionBar';
import { MathPanel } from '../MathPanel';
import { computeHeroAnalysis } from '../../utils/analysis';
import { formatBB, formatSigned } from '../../utils/format';
import { BB_CHIPS } from '../../engine/gameTypes';

function TurnTimer({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span className={left <= 5 ? 'text-rose-400' : 'text-slate-300'}>{left}s</span>;
}

export function OnlineGameView({ view, onExit }: { view: RoomView; onExit: () => void }) {
  const { act, rebuy, ready, backToLobby } = useOnlineStore();
  const game = view.game!;
  const youSeatId = view.youSeatId;
  const isYourTurn = view.toActSeatId === youSeatId && youSeatId !== null && !view.handOver;

  const readySet = new Set(view.readySeatIds ?? []);
  const youReady = youSeatId !== null && readySet.has(youSeatId);
  // Active human seats we are waiting on (connected, with chips).
  const waitingNames = view.seats
    .filter((s) => s.kind === 'human' && s.connected && s.stack > 0 && !readySet.has(s.seatId))
    .map((s) => s.name);
  const youAreActiveHuman =
    youSeatId !== null && view.seats.some((s) => s.seatId === youSeatId && s.kind === 'human' && s.stack > 0);

  const youGame = youSeatId !== null ? game.players[youSeatId] : null;
  const youSeatView = youSeatId !== null ? view.seats.find((s) => s.seatId === youSeatId) : undefined;
  // Use the authoritative SEAT stack (reflects rebuys immediately) — not the
  // in-hand player stack, which lags behind after a mid-hand rebuy.
  const seatStack = youSeatView?.stack ?? 0;
  // Still contesting the current hand (e.g. all-in) -> don't offer a rebuy yet.
  const liveInHand = !view.handOver && !!youGame && !youGame.folded && !youGame.sittingOut;
  const needRebuy = !!youSeatView && youSeatView.kind === 'human' && seatStack <= 0 && !liveInHand;

  // Anytime top-up: available whenever the stack is below the buy-in. Mid-hand
  // requests are queued by the server and applied at the next hand.
  const buyIn = view.config.startingStackBB * BB_CHIPS;
  const canTopUp = !!youSeatView && youSeatView.kind === 'human' && seatStack < buyIn && !needRebuy;
  const topUpPending = !!youSeatView?.pendingTopUp;

  const analysis = useMemo(
    () => (isYourTurn ? computeHeroAnalysis(game, 800) : null),
    [isYourTurn, game],
  );

  const thinkingId =
    view.toActSeatId != null && view.seatKinds?.[view.toActSeatId] === 'ai' ? view.toActSeatId : null;

  const seatNet = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of view.seats) m[s.seatId] = s.net;
    return m;
  }, [view.seats]);

  const toActName =
    view.toActSeatId != null ? game.players[view.toActSeatId]?.name ?? '' : '';
  const turnText = view.handOver
    ? '本手结束'
    : isYourTurn
      ? '轮到你行动'
      : view.toActSeatId != null
        ? `等待 ${toActName} 行动…`
        : '发牌中…';

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col px-3 py-3">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-sky-300">局域网联机</h1>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">第 {game.handNumber} 手</span>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
          {turnText}
          {isYourTurn && view.turnDeadline ? (
            <>
              {' · '}
              <TurnTimer deadline={view.turnDeadline} />
            </>
          ) : null}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canTopUp &&
            (topUpPending ? (
              <span className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-emerald-300" title="下一手开始时补至买入额">
                已申请补码 ✓
              </span>
            ) : (
              <button
                onClick={rebuy}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600"
                title={`补码至买入额 ${formatBB(buyIn)}（若在牌局中，下一手生效）`}
              >
                补码
              </button>
            ))}
          {view.isHost && (
            <button onClick={backToLobby} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700">
              返回大厅
            </button>
          )}
          <button onClick={onExit} className="rounded-lg bg-rose-800 px-3 py-1.5 text-sm hover:bg-rose-700">
            离开
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-3">
          <PokerTable
            game={game}
            thinkingId={thinkingId}
            showHud={false}
            opponentStats={{}}
            resultText={view.lastResultText ?? ''}
            handOver={!!view.handOver}
            seatNet={seatNet}
          />

          {needRebuy ? (
            <div className="rounded-xl bg-slate-900/80 p-4 ring-1 ring-rose-600/40">
              {view.lastResultText && (
                <div className="mb-2 text-center text-sm font-semibold text-yellow-200">{view.lastResultText}</div>
              )}
              <div className="flex flex-wrap items-center justify-center gap-3">
                <span className="text-rose-300">你的筹码已输光（累计盈亏仍照常统计）。</span>
                <button
                  onClick={rebuy}
                  className="rounded-lg bg-gradient-to-r from-emerald-600 to-amber-600 px-5 py-2 font-bold text-white shadow hover:brightness-110 active:scale-95"
                >
                  补码继续 (Rebuy)
                </button>
              </div>
              <div className="mt-2 text-center text-xs text-slate-400">
                {view.message ?? '补码后将在下一手加入牌桌。'}
              </div>
            </div>
          ) : view.handOver ? (
            <div className="rounded-xl bg-slate-900/80 p-4 ring-1 ring-amber-600/30">
              <div className="mb-2 text-center text-sm font-semibold text-yellow-200">
                {view.lastResultText || '本手结束'}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {youAreActiveHuman ? (
                  youReady ? (
                    <span className="text-sm text-emerald-300">已准备 ✓</span>
                  ) : (
                    <button
                      onClick={ready}
                      className="rounded-lg bg-gradient-to-r from-emerald-600 to-amber-600 px-6 py-2 font-bold text-white shadow hover:brightness-110 active:scale-95"
                    >
                      下一手 →
                    </button>
                  )
                ) : (
                  <span className="text-sm text-slate-400">观战中…</span>
                )}
              </div>
              <div className="mt-2 text-center text-xs text-slate-400">
                {view.message
                  ? view.message
                  : waitingNames.length > 0
                    ? `等待 ${waitingNames.join('、')} 点击「下一手」…`
                    : '全部就绪，即将开始下一手…'}
              </div>
            </div>
          ) : youSeatId === null ? (
            <div className="rounded-xl bg-slate-900/60 p-4 text-center text-slate-400">
              你正在观战。可在「返回大厅」后选择一个空座加入。
            </div>
          ) : (
            <ActionBar game={game} onAct={act} />
          )}
        </div>

        <aside className="flex flex-col gap-3">
          <MathPanel analysis={analysis} isHeroTurn={isYourTurn} />
          <PlayersPanel view={view} />
        </aside>
      </div>
    </div>
  );
}

function PlayersPanel({ view }: { view: RoomView }) {
  return (
    <div className="rounded-xl bg-slate-900/70 p-3 ring-1 ring-slate-700">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">座位</h3>
      <ul className="space-y-1 text-sm">
        {view.seats
          .filter((s) => s.kind !== 'empty')
          .map((s) => (
            <li key={s.seatId} className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-slate-300">
                {s.name}
                {s.kind === 'ai' && <span className="rounded bg-fuchsia-700 px-1 text-[10px]">AI</span>}
                {s.kind === 'human' && !s.connected && <span className="text-rose-400">（掉线）</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-yellow-300">{formatBB(s.stack)}</span>
                <span
                  className={`font-mono text-xs ${s.net > 0 ? 'text-emerald-400' : s.net < 0 ? 'text-rose-400' : 'text-slate-500'}`}
                  title="本桌历史盈亏"
                >
                  {formatSigned(s.net)}
                </span>
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
