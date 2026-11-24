// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useState, type ReactNode } from 'react';
import { Drawer } from 'vaul';
import { X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './table';
import { cn, dash, num, pct, STATE, useFile, useWidth, when, type Detail, type Fn, type State, type Summary } from './lib';
import { Chip, Empty, Pill, Search, StatePill } from './ui';

const mono = (v: ReactNode) => <span className="font-mono text-xs">{v}</span>;
export const COLS: Record<string, ColumnDef<Fn, any>> = {
  va: { id: 'va', header: 'Address', accessorKey: 'va', size: 8, cell: (c) => mono(c.getValue()) },
  name: { id: 'name', header: 'Name', accessorKey: 'name', size: 18, cell: (c) => dash(c.getValue()) },
  size: { id: 'size', header: 'Size', accessorKey: 'size', size: 4.5, sortUndefined: 'last', cell: (c) => num(c.getValue()) },
  state: { id: 'state', header: 'State', accessorFn: (r) => STATE[r.state].label, size: 13, cell: (c) => <StatePill s={c.row.original.state} /> },
  route: { id: 'route', header: 'Route', accessorKey: 'route', size: 9, cell: (c) => dash(c.getValue()) },
  model: { id: 'model', header: 'Model', accessorKey: 'model', size: 9.5, cell: (c) => dash(c.getValue()) },
  harness: { id: 'harness', header: 'Harness', accessorKey: 'harness', size: 6.5, cell: (c) => dash(c.getValue()) },
  attempts: { id: 'attempts', header: 'Attempts', accessorKey: 'attempts', size: 5.5, cell: (c) => num(c.getValue()) },
  near: { id: 'near', header: 'Aligned', accessorKey: 'nearAligned', size: 5.5, cell: (c) => pct(c.getValue()) },
  exact: { id: 'exact', header: 'Exact', accessorKey: 'nearExact', size: 5, cell: (c) => pct(c.getValue()) },
  nearReason: { id: 'nearReason', header: 'Comparator result', accessorKey: 'nearReason', size: 11, cell: (c) => dash(c.getValue()) },
  category: { id: 'category', header: 'Reason (last verdict)', accessorKey: 'category', size: 10.5, cell: (c) => dash(c.getValue()) },
  last: { id: 'last', header: 'Last attempt', accessorKey: 'last', size: 7.5, cell: (c) => when(c.getValue()) },
  verifiedAt: { id: 'verifiedAt', header: 'Verified', accessorKey: 'verifiedAt', size: 7.5, cell: (c) => when(c.getValue()) },
};

export function FunctionTable({ rows, s, cols, initial, states, open, setOpen, foot }: {
  rows: Fn[]; s: Summary; cols: string[]; initial: string; states: State[]; open: string | null; setOpen: (v: string | null) => void; foot?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [st, setSt] = useState<State | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const wide = useWidth() >= 1800;
  const models = useMemo(() => [...new Set(rows.map((r) => r.model).filter(Boolean))].sort() as string[], [rows]);
  const data = useMemo(() => rows.filter((r) => (!st || r.state === st) && (!model || r.model === model)
    && (!text || `${r.va} ${r.rva} ${r.name} ${r.unit} ${r.route} ${r.model} ${r.harness} ${r.category} ${r.reason}`.toLowerCase().includes(text.toLowerCase()))), [rows, st, model, text]);
  const columns = useMemo(() => {
    const label = new Map([...s.reasons, ...s.heldReasons].map((r) => [r.key, r.label]));
    return cols.map((c) => c === 'category' ? { ...COLS.category!, accessorFn: (r: Fn) => (r.category && label.get(r.category)) ?? r.category, accessorKey: undefined } as ColumnDef<Fn, any> : COLS[c]!);
  }, [cols, s.reasons, s.heldReasons]);
  const sel = open ? rows.find((r) => r.rva === open) ?? null : null;
  const panel = sel && <FnPanel fn={sel} s={s} onClose={() => setOpen(null)} />;
  return (
    <div className="flex items-start gap-3.5">
      <section className="card min-w-0 flex-1 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Search value={text} onChange={setText} placeholder="Filter address, name, unit, reason" />
          <Chip on={!st} onClick={() => setSt(null)}>All {num(rows.length)}</Chip>
          {states.filter((x) => rows.some((r) => r.state === x)).map((x) => <Chip key={x} on={st === x} onClick={() => setSt(st === x ? null : x)}>{STATE[x].label} {num(rows.filter((r) => r.state === x).length)}</Chip>)}
          <select value={model ?? ''} onChange={(e) => setModel(e.target.value || null)} aria-label="Model" className="h-8 rounded-full border border-line bg-card px-3 text-xs">
            <option value="">Every model</option>{models.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <DataTable data={data} columns={columns} initial={[{ id: initial, desc: true }]} rowKey={(r) => r.rva} selected={open} onRow={(r) => setOpen(r.rva)} />
        {foot && <div className="mt-2 space-y-1 text-xs text-mute">{foot}</div>}
      </section>
      {wide ? panel && <aside className="card sticky top-3 max-h-[calc(100vh-1.5rem)] w-[40rem] shrink-0 overflow-auto p-5">{panel}</aside> : (
        <Drawer.Root open={!!sel} onOpenChange={(o) => !o && setOpen(null)} direction={innerWidth < 720 ? 'bottom' : 'right'}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-30 bg-black/35" />
            <Drawer.Content aria-describedby={undefined} className={cn('card fixed z-40 overflow-x-hidden overflow-y-auto p-5 outline-none', innerWidth < 720 ? 'inset-x-0 bottom-0 max-h-[88vh] !rounded-b-none' : 'inset-y-3 right-3 w-[42rem] max-w-[92vw]')}>
              <Drawer.Title className="sr-only">Function details</Drawer.Title>
              <div data-vaul-no-drag>{panel}</div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </div>
  );
}

function FnPanel({ fn, s, onClose }: { fn: Fn; s: Summary; onClose: () => void }) {
  const d = useFile<Detail>(`detail/${fn.rva}`, s.generatedAt);
  const facts: [string, ReactNode][] = [
    ['Address', mono(`${fn.va} (RVA ${fn.rva})`)], ['Size', fn.size === null ? '—' : `${num(fn.size)} B`], ['Route', dash(fn.route)],
    ['Model', fn.model ? `${fn.model} (from ${fn.modelSource})` : '—'], ['Harness', dash(fn.harness)], ['Attempts', num(fn.attempts)],
    ['Best failing compare', fn.nearAligned === null ? '—' : `${pct(fn.nearAligned)} aligned, ${pct(fn.nearExact)} exact`],
    ['Filed', fn.filedAt ? `${when(fn.filedAt)}${fn.pr ? `, PR ${fn.pr}` : ''} (${fn.filedSource})` : '—'], ['Verified', when(fn.verifiedAt)],
    ['Upstream now', fn.upstream ? `${fn.upstream} (${fn.upstreamOwner})` : '—'], ['Local claim', dash(fn.claim)], ['Unit', mono(dash(fn.unit))],
  ];
  return (
    <div>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0"><h3 className="text-base font-semibold break-words">{fn.name ?? fn.rva}</h3><div className="mt-1 flex gap-1.5"><StatePill s={fn.state} />{fn.held && <Pill>{fn.held.replace('_', ' ')}</Pill>}{fn.bytePass && <Pill tone="cool">byte match seen locally</Pill>}</div></div>
        <button onClick={onClose} aria-label="Close" className="ml-auto rounded-full p-1.5 hover:bg-soft"><X className="size-4" /></button>
      </div>
      <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">{facts.map(([k, v]) => <div key={k} className="contents"><dt className="text-mute">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}</dl>
      {fn.reason && <><h4 className="mt-4 mb-1 text-xs font-semibold">Reason on record</h4><pre className="rounded-xl bg-soft p-3 font-mono text-[.6875rem] whitespace-pre-wrap">{fn.reason}</pre></>}
      <h4 className="mt-4 mb-1 text-xs font-semibold">Attempt timeline</h4>
      {!d ? <p className="text-mute">Loading</p> : !d.timeline.length ? <Empty>No attempt or compare record for this function.</Empty> : (
        <ol className="max-h-72 space-y-2 overflow-auto border-l border-line pl-3">
          {d.timeline.map((t, i) => (
            <li key={i} className="text-xs">
              <div className="flex flex-wrap items-center gap-1.5"><b>#{t.n}</b><span className="text-mute">{when(t.at)}</span><span>{t.model ?? (t.status === 'compare' ? 'compare run' : '—')}</span>
                <Pill tone={t.decision === 'pass' ? 'cool' : 'none'}>{t.decision ?? t.status}</Pill>
                {t.aligned !== null && t.target ? <span className="text-mute">{t.aligned}/{t.target} B aligned</span> : null}</div>
              {t.codes.length > 0 && <div className="font-mono text-[.625rem] text-mute">{t.codes.join(', ')}</div>}
              {t.error && <div className="text-mute">{t.error}</div>}
            </li>
          ))}
        </ol>
      )}
      <h4 className="mt-4 mb-1 text-xs font-semibold">C++ source <span className="font-normal text-mute">{d?.sourceNote}</span></h4>
      {d && !d.source && <Empty>{d.sourceNote ?? 'No source recorded.'}</Empty>}
      {d?.source?.map((f) => (
        <div key={f.path} className="mb-3">
          <div className="mb-1 font-mono text-[.6875rem] break-all text-mute">{f.path}</div>
          <pre className="src max-h-[28rem] overflow-auto rounded-xl bg-soft p-3 font-mono text-[.6875rem] leading-relaxed">{paint(f.content)}</pre>
        </div>
      ))}
    </div>
  );
}

const TOK = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\b(class|struct|enum|namespace|return|if|else|for|while|switch|case|break|const|constexpr|static|virtual|void|bool|char|int|float|double|auto|template|typename|public|private|protected|this|new|delete|using|nullptr|true|false|override|reinterpret_cast|static_cast)\b|\b(0x[0-9a-fA-F]+|\d+)\b/g;
function paint(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of src.matchAll(TOK)) {
    if (m.index > at) out.push(src.slice(at, m.index));
    out.push(<span key={m.index} className={m[1] ? 'c' : m[2] ? 'k' : 'n'}>{m[0]}</span>);
    at = m.index + m[0].length;
  }
  out.push(src.slice(at));
  return out;
}
