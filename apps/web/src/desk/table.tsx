// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react';
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from './lib';

/** Sortable, virtualised table. Column `size` is in rem, so it follows the density setting. */
export function DataTable<T>({ data, columns, filter, initial, onRow, selected, rowKey, height = '70vh' }: {
  data: T[]; columns: ColumnDef<T, any>[]; filter?: string; initial?: SortingState; onRow?: (r: T) => void; selected?: string | null; rowKey: (r: T) => string; height?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initial ?? []);
  const box = useRef<HTMLDivElement>(null);
  const t = useReactTable({
    data, columns, state: { sorting, globalFilter: filter ?? '' }, onSortingChange: setSorting, sortDescFirst: true, globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
    getColumnCanGlobalFilter: () => true,
  });
  const rows = t.getRowModel().rows;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => 2.25 * rem, overscan: 12 });
  const width = columns.reduce((a, c) => a + (c.size ?? 8), 0);
  const cell = (size: number | undefined) => ({ flex: `${size ?? 8} 0 ${size ?? 8}rem`, minWidth: 0 });
  return (
    <div>
      <div ref={box} className="overflow-auto rounded-xl border border-line" style={{ height }} tabIndex={0} role="table" aria-rowcount={rows.length}>
        <div style={{ minWidth: `${width}rem` }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-card" role="row">
            {t.getFlatHeaders().map((h) => (
              <button key={h.id} role="columnheader" onClick={h.column.getToggleSortingHandler()} style={cell(h.column.columnDef.size)}
                aria-sort={h.column.getIsSorted() === 'asc' ? 'ascending' : h.column.getIsSorted() === 'desc' ? 'descending' : 'none'}
                className="flex items-center gap-1 px-2.5 py-2 text-left text-xs font-medium text-mute hover:text-ink">
                {flexRender(h.column.columnDef.header, h.getContext())}
                {h.column.getIsSorted() === 'asc' ? <ArrowUp className="size-3" /> : h.column.getIsSorted() === 'desc' ? <ArrowDown className="size-3" /> : null}
              </button>
            ))}
          </div>
          <div className="relative" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((vi) => {
              const r = rows[vi.index]!;
              const k = rowKey(r.original);
              return (
                <div key={r.id} role="row" tabIndex={onRow ? 0 : undefined} onClick={() => onRow?.(r.original)} onKeyDown={(e) => e.key === 'Enter' && onRow?.(r.original)}
                  className={cn('absolute inset-x-0 flex items-center border-b border-line text-[.8125rem]', onRow && 'cursor-pointer hover:bg-soft', selected === k && 'bg-coolsoft')}
                  style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}>
                  {r.getVisibleCells().map((c) => <div key={c.id} role="cell" style={cell(c.column.columnDef.size)} className="truncate px-2.5">{flexRender(c.column.columnDef.cell, c.getContext())}</div>)}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-mute">{rows.length.toLocaleString('en-US')} of {data.length.toLocaleString('en-US')} rows</p>
    </div>
  );
}
