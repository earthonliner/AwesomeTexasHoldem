import { useState } from 'react';
import { useOnlineStore } from '../../online/useOnlineStore';

export function ConnectScreen({ onBack }: { onBack: () => void }) {
  const connect = useOnlineStore((s) => s.connect);
  const status = useOnlineStore((s) => s.status);
  const error = useOnlineStore((s) => s.error);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const onConnect = () => {
    if (!name.trim()) return;
    connect(name.trim(), url.trim() || undefined);
  };

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <h1 className="bg-gradient-to-r from-sky-300 to-emerald-300 bg-clip-text text-3xl font-extrabold text-transparent">
          局域网联机
        </h1>
        <p className="mt-2 text-slate-400">多名真人 + 人机同桌，无需互联网，只要在同一 Wi-Fi 下。</p>
      </div>

      <div className="space-y-4 rounded-2xl bg-slate-900/70 p-5 ring-1 ring-slate-700">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-200">你的昵称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onConnect()}
            maxLength={16}
            placeholder="例如：小明"
            className="w-full rounded-lg bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-1 ring-slate-600 focus:ring-amber-500"
          />
        </div>

        <button onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-sky-400 hover:underline">
          {showAdvanced ? '收起服务器地址 ▲' : '手动输入服务器地址（高级）▼'}
        </button>
        {showAdvanced && (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-200">服务器地址</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://192.168.x.x:8080/ws（留空则自动使用当前网址）"
              className="w-full rounded-lg bg-slate-800 px-3 py-2 font-mono text-sm text-slate-100 outline-none ring-1 ring-slate-600 focus:ring-amber-500"
            />
          </div>
        )}

        {error && <div className="rounded-lg bg-rose-900/40 px-3 py-2 text-sm text-rose-200">{error}</div>}

        <button
          onClick={onConnect}
          disabled={!name.trim() || status === 'connecting'}
          className="w-full rounded-xl bg-gradient-to-r from-sky-600 to-emerald-600 py-3 text-lg font-bold text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:opacity-50"
        >
          {status === 'connecting' ? '连接中…' : '加入牌桌'}
        </button>
        <button onClick={onBack} className="w-full rounded-xl border border-slate-600 bg-slate-800 py-2 text-sm text-slate-300 hover:bg-slate-700">
          返回
        </button>
      </div>

      <div className="mt-4 rounded-xl bg-slate-900/50 p-4 text-xs leading-relaxed text-slate-400">
        <p className="mb-1 font-semibold text-slate-300">如何开一桌局域网联机：</p>
        <ol className="list-decimal space-y-1 pl-4">
          <li>房主在电脑上构建并启动服务器：<code className="text-slate-200">npm run build &amp;&amp; npm run server</code></li>
          <li>终端会打印形如 <code className="text-slate-200">http://192.168.x.x:8080</code> 的局域网地址。</li>
          <li>同一 Wi-Fi 下的其他人用浏览器打开该地址 → 选「局域网联机」→ 输入昵称加入。</li>
          <li>房主在大厅里添加 AI、设置盲注后点「开始」。</li>
        </ol>
      </div>
    </div>
  );
}
