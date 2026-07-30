import type { RoomView, TableConfig } from '../../online/protocol';
import { useOnlineStore } from '../../online/useOnlineStore';
import { formatBB } from '../../utils/format';

const DIFF_LABEL = { easy: '简单', medium: '中等', hard: '困难' } as const;

export function Lobby({ view, onExit }: { view: RoomView; onExit: () => void }) {
  const { sit, stand, addAI, removeAI, setConfig, start } = useOnlineStore();
  const isHost = view.isHost;
  const youSeated = view.youSeatId !== null;
  // Count only seats that can actually be dealt in (matches the server), so the
  // Start button reflects reality after players disconnect.
  const activeCount = view.seats.filter(
    (s) => (s.kind === 'ai' || (s.kind === 'human' && s.connected)) && s.stack > 0,
  ).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-2xl font-bold text-sky-300">联机大厅</h1>
        {isHost && <span className="rounded-full bg-amber-600 px-2 py-0.5 text-xs font-semibold">房主</span>}
        <button onClick={onExit} className="ml-auto rounded-lg bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600">
          离开
        </button>
      </div>

      {/* Config */}
      <div className="mb-4 rounded-xl bg-slate-900/70 p-4 ring-1 ring-slate-700">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">牌桌设置 {!isHost && <span className="text-xs text-slate-500">（仅房主可改）</span>}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ConfigChoice label="座位数" disabled={!isHost} value={view.config.seatCount} options={[2, 3, 4, 6, 8, 9]} onPick={(v) => setConfig({ seatCount: v })} />
          <ConfigChoiceMoney
            label="大盲"
            disabled={!isHost}
            value={view.config.blindLevel}
            options={[0.5, 1, 2, 5]}
            render={(v) => `$${v}`}
            onPick={(v) => setConfig({ blindLevel: v })}
          />
          <ConfigChoiceMoney
            label="买入"
            disabled={!isHost}
            value={view.config.startingStackBB}
            options={[50, 100, 150, 200]}
            render={(v) => `$${v * view.config.blindLevel}`}
            onPick={(v) => setConfig({ startingStackBB: v })}
          />
          <ConfigChoiceStr
            label="难度"
            disabled={!isHost}
            value={view.config.difficulty}
            options={['easy', 'medium', 'hard'] as TableConfig['difficulty'][]}
            render={(v) => DIFF_LABEL[v]}
            onPick={(v) => setConfig({ difficulty: v })}
          />
          <ConfigChoiceMoney
            label="筹码显示"
            disabled={!isHost}
            value={view.config.chipRatio ?? 1}
            options={[1, 10, 20]}
            render={(v) => (v === 1 ? '现金($)' : `${v}:1`)}
            onPick={(v) => setConfig({ chipRatio: v })}
          />
        </div>
      </div>

      {/* Seats */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {view.seats.map((seat) => {
          const isYou = seat.seatId === view.youSeatId;
          return (
            <div
              key={seat.seatId}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
                isYou ? 'border-emerald-500 bg-emerald-900/20' : 'border-slate-700 bg-slate-800/60'
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-sm font-bold">
                {seat.seatId + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-100">
                  {seat.kind === 'empty' ? <span className="text-slate-500">空座</span> : seat.name}
                  {seat.kind === 'ai' && <span className="ml-1 rounded bg-fuchsia-700 px-1 text-[10px]">AI</span>}
                  {isYou && <span className="ml-1 text-emerald-400">（你）</span>}
                </div>
                {seat.kind !== 'empty' && <div className="font-mono text-xs text-yellow-300">{formatBB(seat.stack)}</div>}
              </div>

              {seat.kind === 'empty' && !youSeated && (
                <button onClick={() => sit(seat.seatId)} className="rounded-lg bg-emerald-700 px-3 py-1 text-sm hover:bg-emerald-600">
                  坐下
                </button>
              )}
              {seat.kind === 'empty' && isHost && (
                <button onClick={() => addAI(seat.seatId)} className="rounded-lg bg-fuchsia-700 px-3 py-1 text-sm hover:bg-fuchsia-600">
                  + AI
                </button>
              )}
              {seat.kind === 'ai' && isHost && (
                <button onClick={() => removeAI(seat.seatId)} className="rounded-lg bg-slate-600 px-3 py-1 text-sm hover:bg-slate-500">
                  移除
                </button>
              )}
              {isYou && (
                <button onClick={stand} className="rounded-lg bg-slate-600 px-3 py-1 text-sm hover:bg-slate-500">
                  站起
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-col items-center gap-2">
        {isHost ? (
          <button
            onClick={start}
            disabled={activeCount < 2}
            className="w-full max-w-sm rounded-xl bg-gradient-to-r from-emerald-600 to-amber-600 py-3 text-lg font-bold text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:opacity-50"
          >
            开始游戏（{activeCount} 名玩家）
          </button>
        ) : (
          <p className="text-sm text-slate-400">等待房主开始游戏…</p>
        )}
        {isHost && activeCount < 2 && <p className="text-xs text-slate-500">至少需要 2 名玩家（真人或 AI）。</p>}
      </div>
    </div>
  );
}

function ConfigChoice({
  label,
  value,
  options,
  onPick,
  disabled,
}: {
  label: string;
  value: number;
  options: number[];
  onPick: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <ConfigChoiceMoney label={label} value={value} options={options} render={(v) => `${v}`} onPick={onPick} disabled={disabled} />
  );
}

function ConfigChoiceMoney({
  label,
  value,
  options,
  render,
  onPick,
  disabled,
}: {
  label: string;
  value: number;
  options: number[];
  render: (v: number) => string;
  onPick: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-slate-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o}
            disabled={disabled}
            onClick={() => onPick(o)}
            className={`rounded px-2 py-1 text-xs ${value === o ? 'bg-amber-600 font-semibold text-white' : 'bg-slate-700 text-slate-300'} ${disabled ? 'opacity-60' : 'hover:bg-slate-600'}`}
          >
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfigChoiceStr<T extends string>({
  label,
  value,
  options,
  render,
  onPick,
  disabled,
}: {
  label: string;
  value: T;
  options: T[];
  render: (v: T) => string;
  onPick: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-slate-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o}
            disabled={disabled}
            onClick={() => onPick(o)}
            className={`rounded px-2 py-1 text-xs ${value === o ? 'bg-amber-600 font-semibold text-white' : 'bg-slate-700 text-slate-300'} ${disabled ? 'opacity-60' : 'hover:bg-slate-600'}`}
          >
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}
