// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode } from 'react';
import NumberFlow from '@number-flow/react';
import * as Tip from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import { cn, STATE, type State } from './lib';

export function Card({ title, how, foot, right, className, children }: { title: ReactNode; how?: string; foot?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('card flex flex-col p-5', className)}>
      <header className="mb-2 flex min-h-6 items-center gap-2">
        <h2 className="text-[.8125rem] font-semibold">{title}</h2>
        {how && <Hint text={how} />}
        <div className="ml-auto">{right}</div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
      {foot && <footer className="mt-3 border-t border-line pt-2 text-xs text-mute">{foot}</footer>}
    </section>
  );
}

export function Hint({ text }: { text: string }) {
  return (
    <Tip.Root delayDuration={100}>
      <Tip.Trigger className="text-mute" aria-label="How this is derived"><Info className="size-3.5" /></Tip.Trigger>
      <Tip.Portal><Tip.Content sideOffset={6} collisionPadding={12} className="card z-50 max-w-80 !rounded-2xl p-3 text-xs">{text}</Tip.Content></Tip.Portal>
    </Tip.Root>
  );
}

export function Pill({ children, tone = 'none', className }: { children: ReactNode; tone?: 'none' | 'warm' | 'cool' | 'line'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
      tone === 'warm' ? 'bg-warmsoft text-warm' : tone === 'cool' ? 'bg-coolsoft text-cool'
        : tone === 'line' ? 'border border-dashed border-mute text-mute' : 'bg-soft text-mute', className)}>{children}</span>
  );
}
export const StatePill = ({ s }: { s: State }) => <Pill tone={STATE[s].tone}>{STATE[s].label}</Pill>;

export function Kpi({ title, value, sub, pill, how, foot, className }: { title: string; value: number | null; sub?: ReactNode; pill?: ReactNode; how?: string; foot?: ReactNode; className?: string }) {
  return (
    <Card title={title} how={how} foot={foot} className={className}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="text-[2.75rem] leading-none font-semibold tracking-tight">{value === null ? '—' : <NumberFlow value={value} locales="en-US" />}</div>
        {pill}
      </div>
      {sub && <div className="mt-2 text-xs text-mute">{sub}</div>}
    </Card>
  );
}

/** Filled part, then a hatched remainder up to the limit. Without a limit there is no bar: a dash and the reason. */
export function LimitBar({ label, value, limit, note }: { label: string; value: number | null; limit: number | null; note: string }) {
  const p = limit && value !== null ? Math.min(100, (100 * value) / limit) : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex justify-between text-xs"><span>{label}</span><span className="text-mute"><b className="text-ink">{value ?? '—'}</b> of {limit ?? '—'}</span></div>
      {limit !== null && (
        <div className="hatch h-3 overflow-hidden rounded-full border border-line" role="img" aria-label={`${value} of ${limit}`}>
          <div className="h-full bg-warm" style={{ width: `${p}%` }} />
        </div>
      )}
      <p className="mt-1 text-[.6875rem] text-mute">{note}</p>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="flex items-start gap-3 py-2"><span className="text-3xl text-mute">—</span><p className="max-w-prose pt-1 text-sm text-mute">{children}</p></div>
);
export const Chip = ({ on, children, onClick }: { on: boolean; children: ReactNode; onClick: () => void }) => (
  <button onClick={onClick} aria-pressed={on} className={cn('rounded-full border px-2.5 py-1 text-xs whitespace-nowrap', on ? 'border-ink bg-ink text-card' : 'border-line bg-card text-mute hover:text-ink')}>{children}</button>
);
export const Search = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
    className="h-8 w-64 max-w-full rounded-full border border-line bg-card px-3 text-sm placeholder:text-mute" />
);
