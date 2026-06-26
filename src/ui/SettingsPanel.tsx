import type { Settings } from '../store/types';
import type { Difficulty } from '../engine/gameTypes';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** Settings that only take effect on a new table are flagged for the user. */
  showTableNote?: boolean;
}

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '困难' };
const DIFFICULTY_DESC: Record<Difficulty, string> = {
  easy: '对手性格极端易读、很少诈唬、不看位置。',
  medium: '对手参数均衡、按局面诈唬、有位置意识。',
  hard: '混合策略，并读取你的行为画像反过来针对你。',
};

export function SettingsPanel({ settings, onChange, showTableNote }: Props) {
  return (
    <div className="space-y-4 text-sm">
      <Field label={`同桌人数：${settings.seatCount} 人（含你）`} note={showTableNote ? '下桌生效' : undefined}>
        <input
          type="range"
          min={2}
          max={9}
          value={settings.seatCount}
          onChange={(e) => onChange({ seatCount: Number(e.target.value) })}
          className="w-full accent-amber-500"
        />
      </Field>

      <Field label="大盲级别" note={showTableNote ? '下桌生效' : undefined}>
        <div className="flex gap-1">
          {[0.5, 1, 2, 5].map((lvl) => (
            <Choice key={lvl} active={settings.blindLevel === lvl} onClick={() => onChange({ blindLevel: lvl })}>
              {lvl}
            </Choice>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">小盲为大盲的一半。起始筹码 {settings.startingStackBB} BB。</p>
      </Field>

      <Field label="起始筹码 (BB)" note={showTableNote ? '下桌生效' : undefined}>
        <div className="flex gap-1">
          {[50, 100, 150, 200].map((s) => (
            <Choice key={s} active={settings.startingStackBB === s} onClick={() => onChange({ startingStackBB: s })}>
              {s}
            </Choice>
          ))}
        </div>
      </Field>

      <Field label="难度">
        <div className="flex gap-1">
          {(['easy', 'medium', 'hard'] as Difficulty[]).map((d) => (
            <Choice key={d} active={settings.difficulty === d} onClick={() => onChange({ difficulty: d })}>
              {DIFFICULTY_LABEL[d]}
            </Choice>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">{DIFFICULTY_DESC[settings.difficulty]}</p>
      </Field>

      <Toggle label="音效" checked={settings.sound} onChange={(v) => onChange({ sound: v })} />
      <Toggle label="启用数学参考面板" checked={settings.mathEnabled} onChange={(v) => onChange({ mathEnabled: v })} />
      <Toggle label="快速模式 (缩短 AI 思考)" checked={settings.fastMode} onChange={(v) => onChange({ fastMode: v })} />

      <div>
        <Toggle label="对手行为 HUD" checked={settings.hudEnabled} onChange={(v) => onChange({ hudEnabled: v })} />
        <p className="mt-1 text-xs text-amber-500/80">
          ⚠️ 开启 HUD 会直接展示对手统计，降低你亲自观察、发现对手风格的乐趣。是否使用由你决定。
        </p>
      </div>
    </div>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-slate-200">{label}</span>
        {note && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1.5 text-sm transition ${
        active ? 'bg-amber-600 font-semibold text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center justify-between">
      <span className="text-slate-200">{label}</span>
      <span className={`relative h-6 w-11 rounded-full transition ${checked ? 'bg-emerald-600' : 'bg-slate-600'}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? 'left-[1.375rem]' : 'left-0.5'}`}
        />
      </span>
    </button>
  );
}
