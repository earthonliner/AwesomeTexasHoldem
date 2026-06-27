import { useState } from 'react';
import { useGameStore } from './store/useGameStore';
import { PokerTable } from './ui/PokerTable';
import { ActionBar } from './ui/ActionBar';
import { MathPanel } from './ui/MathPanel';
import { StatsPanel } from './ui/StatsPanel';
import { HistoryPanel } from './ui/HistoryPanel';
import { SettingsPanel } from './ui/SettingsPanel';
import { HandReviewPanel } from './ui/HandReviewPanel';
import { DocsModal } from './ui/DocsModal';

export default function App() {
  const game = useGameStore((s) => s.game);
  const started = game !== null;
  const [showDocs, setShowDocs] = useState(false);

  return (
    <>
      {started ? (
        <GameView onOpenDocs={() => setShowDocs(true)} />
      ) : (
        <StartScreen onOpenDocs={() => setShowDocs(true)} />
      )}
      {showDocs && <DocsModal onClose={() => setShowDocs(false)} />}
    </>
  );
}

function StartScreen({ onOpenDocs }: { onOpenDocs: () => void }) {
  const settings = useGameStore((s) => s.settings);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const newTable = useGameStore((s) => s.newTable);
  const stats = useGameStore((s) => s.stats);

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <h1 className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-4xl font-extrabold text-transparent">
          德州扑克练习
        </h1>
        <p className="mt-2 text-slate-400">单机离线 · 无限注现金局 · 含实时胜率、决策复盘与可观察的 AI 对手</p>
      </div>

      <div className="rounded-2xl bg-slate-900/70 p-5 ring-1 ring-slate-700">
        <SettingsPanel settings={settings} onChange={updateSettings} />
        <button
          onClick={newTable}
          className="mt-5 w-full rounded-xl bg-gradient-to-r from-emerald-600 to-amber-600 py-3 text-lg font-bold text-white shadow-lg transition hover:brightness-110 active:scale-95"
        >
          开始游戏
        </button>
        <button
          onClick={onOpenDocs}
          className="mt-3 w-full rounded-xl border border-slate-600 bg-slate-800 py-2.5 text-base font-semibold text-slate-200 transition hover:bg-slate-700 active:scale-95"
        >
          📖 新手教学 / 规则文档
        </button>
        {stats.handsPlayed > 0 && (
          <p className="mt-3 text-center text-xs text-slate-500">
            历史：已玩 {stats.handsPlayed} 手，累计盈亏 {(stats.netChips / 2).toFixed(1)} BB（已保存）
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-slate-600">提示：运行 <code>npm test</code> 可验证核心算法单元测试。</p>
    </div>
  );
}

function GameView({ onOpenDocs }: { onOpenDocs: () => void }) {
  const {
    game,
    settings,
    stats,
    analysis,
    thinkingId,
    handOver,
    opponentStats,
    history,
    lastResultText,
    heroAct,
    updateSettings,
    resetStats,
    startNextHand,
    newTable,
    rebuyHero,
  } = useGameStore();

  const [showSettings, setShowSettings] = useState(false);
  if (!game) return null;

  const hero = game.players.find((p) => p.isHero)!;
  const isHeroTurn = game.toAct === game.players.findIndex((p) => p.isHero) && game.status === 'betting';
  const heroBusted = hero.stack <= 0 && game.status === 'complete';
  const lastHand = handOver && history.length > 0 ? history[history.length - 1] : null;

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col px-3 py-3">
      {/* Header */}
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-amber-300">德州扑克练习</h1>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
          {settings.seatCount} 人 · 大盲 {settings.blindLevel} · 难度{' '}
          {{ easy: '简单', medium: '中等', hard: '困难' }[settings.difficulty]}
        </span>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">第 {game.handNumber} 手</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onOpenDocs}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
            title="教学文档"
          >
            📖 文档
          </button>
          <button
            onClick={() => updateSettings({ sound: !settings.sound })}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
            title="静音切换"
          >
            {settings.sound ? '🔊' : '🔇'}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
          >
            ⚙️ 设置
          </button>
          <button onClick={newTable} className="rounded-lg bg-rose-800 px-3 py-1.5 text-sm hover:bg-rose-700">
            换桌
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_22rem]">
        {/* Table + actions */}
        <div className="flex flex-col gap-3">
          <PokerTable
            game={game}
            thinkingId={thinkingId}
            showHud={settings.hudEnabled}
            opponentStats={opponentStats}
            resultText={lastResultText}
            handOver={handOver}
          />

          {heroBusted ? (
            <div className="flex items-center justify-between rounded-xl bg-slate-900/80 p-4">
              <span className="text-rose-300">你的筹码已输光。</span>
              <button onClick={rebuyHero} className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold hover:bg-emerald-600">
                补码 (Rebuy)
              </button>
            </div>
          ) : (
            <ActionBar game={game} onAct={heroAct} />
          )}

          {handOver && (
            <div className="flex justify-center">
              <button
                onClick={startNextHand}
                className="rounded-lg bg-slate-700 px-5 py-2 text-sm font-semibold hover:bg-slate-600"
              >
                立即下一手 →
              </button>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="flex flex-col gap-3">
          {showSettings && (
            <div className="rounded-xl bg-slate-900/80 p-4 ring-1 ring-slate-700">
              <SettingsPanel settings={settings} onChange={updateSettings} showTableNote />
            </div>
          )}
          {lastHand && (
            <HandReviewPanel
              decisions={lastHand.decisions}
              resultText={lastResultText}
              heroDelta={lastHand.heroDelta}
              onNext={startNextHand}
            />
          )}
          {settings.mathEnabled && !handOver && <MathPanel analysis={analysis} isHeroTurn={isHeroTurn} />}
          <StatsPanel stats={stats} onReset={resetStats} />
          <HistoryPanel history={history} />
        </aside>
      </div>
    </div>
  );
}
