import { useEffect, useMemo, useState } from 'react';
import type { RoomView } from '../../online/protocol';
import { useOnlineStore } from '../../online/useOnlineStore';
import { PokerTable } from '../PokerTable';
import { ActionBar } from '../ActionBar';
import { MathPanel } from '../MathPanel';
import { computeHeroAnalysis } from '../../utils/analysis';

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
  const { act, rebuy, backToLobby } = useOnlineStore();
  const game = view.game!;
  const youSeatId = view.youSeatId;
  const isYourTurn = view.toActSeatId === youSeatId && youSeatId !== null && !view.handOver;

  const youSeat = youSeatId !== null ? game.players[youSeatId] : null;
  const busted = !!youSeat && youSeat.stack <= 0;

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

          {youSeatId === null ? (
            <div className="rounded-xl bg-slate-900/60 p-4 text-center text-slate-400">
              你正在观战。可在「返回大厅」后选择一个空座加入。
            </div>
          ) : busted && view.handOver ? (
            <div className="flex items-center justify-between rounded-xl bg-slate-900/80 p-4">
              <span className="text-rose-300">你的筹码已输光。</span>
              <button onClick={rebuy} className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold hover:bg-emerald-600">
                补码 (Rebuy)
              </button>
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
                <span className="font-mono text-yellow-300">{(s.stack / 2).toFixed(0)} BB</span>
                <span
                  className={`font-mono text-xs ${s.net > 0 ? 'text-emerald-400' : s.net < 0 ? 'text-rose-400' : 'text-slate-500'}`}
                  title="本桌历史盈亏"
                >
                  {s.net >= 0 ? '+' : ''}
                  {(s.net / 2).toFixed(1)}
                </span>
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
