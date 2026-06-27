import { useRef, useState } from 'react';
import { DOC_SECTIONS, type DocBlock } from '../docs/content';

export function DocsModal({ onClose }: { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(DOC_SECTIONS[0].id);

  const goTo = (id: string) => {
    setActive(id);
    const el = scrollRef.current?.querySelector(`#doc-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/75 p-2 sm:p-6" onClick={onClose}>
      <div
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
          <h2 className="text-lg font-bold text-amber-300">📖 德州扑克教学文档</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600">
            关闭 ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Table of contents */}
          <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-slate-800 p-3 sm:block">
            <ul className="space-y-1">
              {DOC_SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => goTo(s.id)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                      active === s.id ? 'bg-amber-600/20 font-semibold text-amber-300' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {/* Mobile TOC */}
            <div className="mb-4 flex flex-wrap gap-1.5 sm:hidden">
              {DOC_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => goTo(s.id)}
                  className="rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-300"
                >
                  {s.title}
                </button>
              ))}
            </div>

            {DOC_SECTIONS.map((s) => (
              <section key={s.id} id={`doc-${s.id}`} className="mb-8 scroll-mt-2">
                <h3 className="mb-3 border-b border-slate-800 pb-2 text-xl font-bold text-emerald-300">{s.title}</h3>
                <div className="space-y-3">
                  {s.blocks.map((b, i) => (
                    <Block key={i} block={b} />
                  ))}
                </div>
              </section>
            ))}

            <p className="py-4 text-center text-xs text-slate-600">
              以上为练习向教学材料，实战中请结合"数学参考"与"本手复盘"对照学习。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="text-sm leading-relaxed text-slate-300">{block.text}</p>;
    case 'h':
      return <h4 className="pt-2 text-base font-semibold text-amber-200">{block.text}</h4>;
    case 'ul':
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-300">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-300">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} className="border border-slate-700 bg-slate-800 px-2 py-1.5 text-left font-semibold text-slate-200">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className={i % 2 ? 'bg-slate-900' : 'bg-slate-800/40'}>
                  {row.map((cell, j) => (
                    <td key={j} className="border border-slate-800 px-2 py-1.5 text-slate-300">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'tip':
      return (
        <div className="rounded-lg border-l-4 border-emerald-500 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-100">
          💡 {block.text}
        </div>
      );
    case 'example':
      return (
        <div className="rounded-lg border-l-4 border-amber-500 bg-amber-900/15 px-3 py-2 text-sm text-amber-100">
          <span className="font-semibold">📌 {block.title ?? '示例'}：</span>
          {block.text}
        </div>
      );
  }
}
