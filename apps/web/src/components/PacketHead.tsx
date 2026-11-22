// SPDX-License-Identifier: AGPL-3.0-or-later
// The Packets table's header: click a column to sort it, and the funnel that shows on hover filters
// the rows on that column's values.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PacketFacet, PacketFilters, PacketPage, PacketSort } from '../api';

export interface PacketCol {
  key: PacketSort;
  label: string;
  /** values: tick the values to keep; text: contains; range: min and max. */
  filter: { kind: 'values'; facet: PacketFacet } | { kind: 'text'; field: 'unit' | 'fn'; placeholder: string } | { kind: 'range' };
}

export const PACKET_COLS: PacketCol[] = [
  { key: 'unit', label: 'Unit', filter: { kind: 'text', field: 'unit', placeholder: 'Path contains…' } },
  { key: 'functions', label: 'Functions', filter: { kind: 'text', field: 'fn', placeholder: 'Name or address contains…' } },
  { key: 'difficulty', label: 'Difficulty', filter: { kind: 'values', facet: 'difficulty' } },
  { key: 'state', label: 'State', filter: { kind: 'values', facet: 'state' } },
  { key: 'tier', label: 'Tier', filter: { kind: 'values', facet: 'tier' } },
  { key: 'worker', label: 'Worker', filter: { kind: 'values', facet: 'worker' } },
  { key: 'attempts', label: 'Attempts', filter: { kind: 'values', facet: 'attempts' } },
  { key: 'bytes', label: 'Best bytes', filter: { kind: 'range' } },
];

/** Whether a column narrows the rows now. */
export function colFiltered(c: PacketCol, f: PacketFilters): boolean {
  const k = c.filter;
  if (k.kind === 'values') return !!f.values?.[k.facet]?.length;
  if (k.kind === 'text') return !!f[k.field]?.trim();
  return f.bytesMin !== undefined || f.bytesMax !== undefined;
}

/** The filters without this column's. */
export function clearCol(c: PacketCol, f: PacketFilters): PacketFilters {
  const k = c.filter;
  if (k.kind === 'values') {
    const values = { ...f.values };
    delete values[k.facet];
    return { ...f, values };
  }
  if (k.kind === 'text') return { ...f, [k.field]: undefined };
  return { ...f, bytesMin: undefined, bytesMax: undefined };
}

const Funnel = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2h13l-5 6.2V13l-3 1.5V8.2z" fill="currentColor" /></svg>
);

interface Props {
  sort: PacketSort | null;
  dir: 'asc' | 'desc';
  onSort: (key: PacketSort | null, dir: 'asc' | 'desc') => void;
  filters: PacketFilters;
  onFilters: (f: PacketFilters) => void;
  facets: PacketPage['facets'] | null;
  /** How a value of a value-list column reads (a tier's capability, the worker no one has, …). */
  valueLabel: (facet: PacketFacet, v: string | number) => ReactNode;
}

export function PacketHead({ sort, dir, onSort, filters, onFilters, facets, valueLabel }: Props) {
  const [open, setOpen] = useState<{ key: PacketSort; at: HTMLElement } | null>(null);
  const cycle = (key: PacketSort) => {
    // Off → ascending → descending → off.
    if (sort !== key) onSort(key, 'asc');
    else if (dir === 'asc') onSort(key, 'desc');
    else onSort(null, 'asc');
  };
  const col = open ? PACKET_COLS.find((c) => c.key === open.key) ?? null : null;
  return (
    <thead>
      <tr>
        {PACKET_COLS.map((c) => {
          const on = colFiltered(c, filters);
          const sorted = sort === c.key;
          const isOpen = open?.key === c.key;
          return (
            <th key={c.key} aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <span className="th-cell">
                <button className={`th-sort${sorted ? ' on' : ''}`} onClick={() => cycle(c.key)} title={`Sort by ${c.label.toLowerCase()}${sorted ? (dir === 'asc' ? ' (now ascending: click for descending)' : ' (now descending: click to stop sorting)') : ''}`}>
                  {c.label}<span className="arrow" aria-hidden="true">{sorted ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </button>
                <button
                  className={`th-filter${on ? ' on' : ''}${isOpen ? ' open' : ''}`}
                  aria-label={`Filter by ${c.label.toLowerCase()}${on ? ' (filtered)' : ''}`}
                  aria-expanded={isOpen}
                  title={on ? `Filtered by ${c.label.toLowerCase()}: click to change` : `Filter by ${c.label.toLowerCase()}`}
                  onClick={(e) => setOpen(isOpen ? null : { key: c.key, at: e.currentTarget.closest('th') ?? e.currentTarget })}
                ><Funnel /></button>
              </span>
            </th>
          );
        })}
        {col && open && (
          <ColumnFilter key={col.key} col={col} anchor={open.at} filters={filters} onFilters={onFilters} facets={facets} valueLabel={valueLabel} onClose={() => setOpen(null)} />
        )}
      </tr>
    </thead>
  );
}

function ColumnFilter({ col, anchor, filters, onFilters, facets, valueLabel, onClose }: {
  col: PacketCol; anchor: HTMLElement; filters: PacketFilters; onFilters: (f: PacketFilters) => void;
  facets: PacketPage['facets'] | null; valueLabel: Props['valueLabel']; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Placed from the first paint (a hidden box could not take the search field's focus).
  const [pos, setPos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { left: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 268))), top: Math.round(r.bottom + 4) };
  });
  // Under its column, kept on screen, and following the column when the page or table scrolls.
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = ref.current?.offsetWidth ?? 260;
      setPos((p) => {
        const next = { left: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))), top: Math.round(r.bottom + 4) };
        return p.left === next.left && p.top === next.top ? p : next;
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('.th-filter')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const on = colFiltered(col, filters);
  // On the page body, so the table's scroll box does not clip it.
  return createPortal(
    <div ref={ref} className="col-pop" role="dialog" aria-label={`Filter by ${col.label.toLowerCase()}`} style={{ left: pos.left, top: pos.top }}>
        <div className="row" style={{ gap: 8 }}>
          <b className="grow small">{col.label}</b>
          <button className="link small" disabled={!on} onClick={() => onFilters(clearCol(col, filters))}>Clear</button>
        </div>
        {col.filter.kind === 'values' && <ValuesFilter facet={col.filter.facet} filters={filters} onFilters={onFilters} facets={facets} valueLabel={valueLabel} />}
        {col.filter.kind === 'text' && <TextFilter field={col.filter.field} placeholder={col.filter.placeholder} filters={filters} onFilters={onFilters} />}
        {col.filter.kind === 'range' && <RangeFilter filters={filters} onFilters={onFilters} />}
    </div>,
    document.body,
  );
}

function ValuesFilter({ facet, filters, onFilters, facets, valueLabel }: {
  facet: PacketFacet; filters: PacketFilters; onFilters: (f: PacketFilters) => void; facets: PacketPage['facets'] | null; valueLabel: Props['valueLabel'];
}) {
  const [find, setFind] = useState('');
  const picked = filters.values?.[facet] ?? [];
  const has = (v: string | number) => picked.some((p) => String(p) === String(v));
  // The values with packets under the other filters, plus any ticked one that has none now.
  const listed = facets?.[facet] ?? [];
  const all = [...listed, ...picked.filter((p) => !listed.some((l) => String(l.value) === String(p))).map((value) => ({ value, n: 0 }))];
  const shown = find.trim() ? all.filter((x) => String(x.value).toLowerCase().includes(find.trim().toLowerCase())) : all;
  const set = (values: Array<string | number>) => onFilters({ ...filters, values: { ...filters.values, [facet]: values } });
  const toggle = (v: string | number) => set(has(v) ? picked.filter((p) => String(p) !== String(v)) : [...picked, v]);
  return (
    <>
      {all.length > 8 && <input autoFocus placeholder="Find a value…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a value" />}
      <div className="col-pop-list">
        {shown.map(({ value, n }) => (
          <label key={String(value)} className="col-pop-item">
            <input type="checkbox" checked={has(value)} onChange={() => toggle(value)} />
            <span className="grow">{valueLabel(facet, value)}</span>
            <span className="muted small">{n.toLocaleString()}</span>
          </label>
        ))}
        {!shown.length && <span className="muted small">{facets ? 'No values.' : 'Loading…'}</span>}
      </div>
      <div className="row small" style={{ gap: 8 }}>
        <span className="muted grow">{picked.length ? `Showing ${picked.length} value${picked.length === 1 ? '' : 's'}` : 'None ticked: every value shows'}</span>
        {shown.length > 1 && <button className="link small" onClick={() => set(shown.map((x) => x.value))}>Tick all{find.trim() ? ' found' : ''}</button>}
      </div>
    </>
  );
}

/** Applies a moment after the last key, so typing does not fire a query per letter. */
function useSoon<T>(value: T, apply: (v: T) => void, ms = 300) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => apply(value), ms);
    return () => clearTimeout(t);
  }, [value]);
}

function TextFilter({ field, placeholder, filters, onFilters }: { field: 'unit' | 'fn'; placeholder: string; filters: PacketFilters; onFilters: (f: PacketFilters) => void }) {
  const [text, setText] = useState(filters[field] ?? '');
  const latest = useRef(filters);
  latest.current = filters;
  useSoon(text, (v) => onFilters({ ...latest.current, [field]: v.trim() ? v : undefined }));
  return (
    <>
      <input autoFocus placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} aria-label={placeholder} />
      <span className="muted small">Any case; part of a word is enough.</span>
    </>
  );
}

function RangeFilter({ filters, onFilters }: { filters: PacketFilters; onFilters: (f: PacketFilters) => void }) {
  const [min, setMin] = useState(filters.bytesMin === undefined ? '' : String(filters.bytesMin));
  const [max, setMax] = useState(filters.bytesMax === undefined ? '' : String(filters.bytesMax));
  const latest = useRef(filters);
  latest.current = filters;
  const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
  useSoon(`${min}|${max}`, () => onFilters({ ...latest.current, bytesMin: num(min), bytesMax: num(max) }));
  return (
    <div className="row" style={{ gap: 8 }}>
      <label className="small grow">At least<input autoFocus type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} /></label>
      <label className="small grow">At most<input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} /></label>
    </div>
  );
}
