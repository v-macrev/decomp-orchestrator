// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { num, reduced, when, type Hist, type Reason, type Summary } from './lib';
import { Pill } from './ui';

const axis = { fontSize: '0.6875rem', fill: 'var(--mute)' } as const;
const tip = {
  contentStyle: { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '0.75rem', fontSize: '0.75rem', color: 'var(--ink)' },
  itemStyle: { color: 'var(--ink)' }, labelStyle: { color: 'var(--mute)' }, cursor: { fill: 'var(--soft)', stroke: 'var(--line)' },
};
const ticks = (a: number, b: number, n = 5) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

/** Fill patterns, so a segment is told apart without its colour. */
const FILLS = ['solid', 'diag', 'dots', 'cross', 'horiz', 'light', 'vert'] as const;
export function Patterns({ id }: { id: string }) {
  const p = (n: string, body: React.ReactNode, color: string) => (
    <pattern key={n} id={`${id}-${n}`} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill={color} fillOpacity=".22" />{body}</pattern>
  );
  return (
    <defs>
      {p('diag', <path d="M0 6L6 0" stroke="var(--cool)" strokeWidth="1.6" />, 'var(--cool)')}
      {p('dots', <circle cx="3" cy="3" r="1.3" fill="var(--warm)" />, 'var(--warm)')}
      {p('cross', <path d="M0 3H6M3 0V6" stroke="var(--cool)" strokeWidth="1" />, 'var(--cool)')}
      {p('horiz', <path d="M0 3H6" stroke="var(--warm)" strokeWidth="1.8" />, 'var(--warm)')}
      {p('light', <path d="" />, 'var(--mute)')}
      {p('vert', <path d="M3 0V6" stroke="var(--mute)" strokeWidth="1.6" />, 'var(--mute)')}
    </defs>
  );
}
const fillOf = (id: string, i: number) => (i === 0 ? 'var(--cool)' : `url(#${id}-${FILLS[i % FILLS.length]})`);

export function CumulativeStep({ data, now }: { data: Summary['cumulative']; now: number }) {
  const end = data.length ? [...data, { ...data[data.length - 1]!, t: now }] : [];
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <AreaChart data={end} margin={{ left: -20, right: 28, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={end.length ? ticks(end[0]!.t, now) : []} tickFormatter={day} tick={axis} stroke="var(--line)" interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={axis} stroke="none" allowDecimals={false} />
          <Tooltip {...tip} labelFormatter={(t) => when(Number(t))} formatter={(v, k) => [num(Number(v)), k === 'n' ? 'verified' : 'bytes']} />
          <Area type="stepAfter" dataKey="n" stroke="var(--cool)" strokeWidth={2} fill="var(--cool)" fillOpacity={0.12} isAnimationActive={!reduced()} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HistoryLines({ data }: { data: Hist[] }) {
  return (
    <div className="h-44">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ left: -20, right: 28, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={ticks(data[0]!.t, data[data.length - 1]!.t, 3)} tickFormatter={(t) => when(t)} tick={axis} stroke="var(--line)" interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={axis} stroke="none" allowDecimals={false} />
          <Tooltip {...tip} labelFormatter={(t) => when(Number(t))} />
          <Line type="stepAfter" dataKey="filed" stroke="var(--warm)" strokeDasharray="5 3" dot={false} isAnimationActive={false} />
          <Line type="stepAfter" dataKey="verified" stroke="var(--cool)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="stepAfter" dataKey="awaiting" stroke="var(--mute)" strokeDasharray="1 3" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Donut({ data, by = 'count' }: { data: Reason[]; by?: 'count' | 'bytes' }) {
  const id = useId().replace(/:/g, '');
  const total = data.reduce((a, r) => a + r[by], 0);
  let acc = 0;
  const arc = (a0: number, a1: number) => {
    const pt = (a: number, r: number) => [60 + r * Math.sin(a), 60 - r * Math.cos(a)].map((x) => x.toFixed(2)).join(' ');
    const big = a1 - a0 > Math.PI ? 1 : 0;
    return `M${pt(a0, 56)}A56 56 0 ${big} 1 ${pt(a1, 56)}L${pt(a1, 34)}A34 34 0 ${big} 0 ${pt(a0, 34)}Z`;
  };
  if (!total) return <p className="text-mute">—</p>;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 120 120" className="w-36 shrink-0" role="img" aria-label="Donut of release reasons">
        <Patterns id={id} />
        {data.map((r, i) => {
          const a0 = (acc / total) * 2 * Math.PI;
          acc += r[by];
          return <path key={r.key} d={arc(a0, Math.min((acc / total) * 2 * Math.PI, 2 * Math.PI - 0.0001))} fill={fillOf(id, i)} stroke="var(--card)" strokeWidth="1.5" />;
        })}
        <text x="60" y="60" textAnchor="middle" fontSize="20" fontWeight="600" fill="var(--ink)">{num(total)}</text>
        <text x="60" y="74" textAnchor="middle" fontSize="8" fill="var(--mute)">{by === 'count' ? 'functions' : 'bytes'}</text>
      </svg>
      <ul className="min-w-48 flex-1 space-y-1 text-xs">
        {data.map((r, i) => (
          <li key={r.key} className="flex items-center gap-2">
            <svg width="14" height="14" className="shrink-0"><Patterns id={`${id}l${i}`} /><rect width="14" height="14" rx="3" fill={i === 0 ? 'var(--cool)' : `url(#${id}l${i}-${FILLS[i % FILLS.length]})`} /></svg>
            <span className="truncate">{r.label}</span><b className="ml-auto">{num(r[by])}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReasonBars({ data, by }: { data: Reason[]; by: 'count' | 'bytes' }) {
  const sorted = [...data].sort((a, b) => b[by] - a[by]);
  return (
    <div style={{ height: `${Math.max(4, sorted.length * 2.25 + 1.5)}rem` }}>
      <ResponsiveContainer>
        <BarChart data={sorted} layout="vertical" margin={{ left: 8, right: 40 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={150} tick={axis} stroke="none" interval={0} />
          <Tooltip {...tip} formatter={(v) => [num(Number(v)), by === 'count' ? 'functions' : 'bytes']} />
          <Bar dataKey={by} fill={by === 'count' ? 'var(--cool)' : 'var(--warm)'} radius={4} barSize={14} isAnimationActive={false} label={{ position: 'right', ...axis, formatter: (v: any) => num(Number(v)) }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** One column of dots per hour; the number of dots is proportional to the busiest hour. */
export function DotHours({ data, unit }: { data: number[]; unit: string }) {
  const max = Math.max(...data), rows = 8, peak = data.indexOf(max);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-mute">
        <Pill tone="warm">peak {String(peak).padStart(2, '0')}:00, {num(max)} {unit}</Pill>
        <span>1 dot = up to {num(Math.ceil(max / rows))}</span>
      </div>
      <svg viewBox="0 0 240 80" className="w-full max-w-xl" role="img" aria-label={`${unit} per hour of day, peak at ${peak}:00`}>
        {data.map((v, h) => Array.from({ length: rows }, (_, i) => {
          const on = max > 0 && v > 0 && i < Math.ceil((v / max) * rows);
          return <circle key={`${h}-${i}`} cx={h * 10 + 5} cy={70 - i * 9} r={on ? 3 : 1.2} fill={on ? (h === peak ? 'var(--warm)' : 'var(--cool)') : 'var(--mute)'} fillOpacity={on ? 1 : 0.35}><title>{`${h}:00, ${v} ${unit}`}</title></circle>;
        }))}
      </svg>
      <div className="flex max-w-xl justify-between text-[.625rem] text-mute"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function ActivityGrid({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <svg viewBox="0 0 282 118" className="w-full max-w-[38rem]" role="img" aria-label="Attempts by weekday and hour">
      {grid.map((row, d) => (
        <g key={d}>
          <text x="0" y={d * 14 + 11} fontSize="6" fill="var(--mute)">{DAYS[d]}</text>
          {row.map((v, h) => {
            const s = v ? 3 + 8 * Math.sqrt(v / max) : 1.5;
            return <rect key={h} x={24 + h * 10.7 + (11 - s) / 2} y={d * 14 + 2 + (11 - s) / 2} width={s} height={s} rx={s / 4} fill={v ? 'var(--cool)' : 'var(--mute)'} fillOpacity={v ? 0.45 + 0.55 * (v / max) : 0.4}><title>{`${DAYS[d]} ${h}:00, ${v} attempts`}</title></rect>;
          })}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={24 + h * 10.7 + 5.5} y="110" fontSize="6" textAnchor="middle" fill="var(--mute)">{String(h).padStart(2, '0')}</text>)}
    </svg>
  );
}

export function Funnel({ f }: { f: Summary['funnel'] }) {
  const steps = [['Screened', f.screened], ['Claimed', f.claimed], ['Matched', f.matched], ['Filed', f.filed], ['Verified', f.verified]] as const;
  return (
    <ol className="space-y-1.5">
      {steps.map(([label, n], i) => (
        <li key={label} className="text-xs">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-mute">{label}</span>
            <div className="h-6 flex-1 rounded-lg bg-soft"><div className="h-full rounded-lg bg-cool" style={{ width: `${Math.max(0.6, (100 * n) / f.screened)}%`, opacity: 1 - i * 0.12 }} /></div>
            <b className="w-10 shrink-0 text-right">{num(n)}</b>
          </div>
          {label === 'Matched' && (
            <div className="mt-1.5 flex items-center gap-2 text-mute">
              <span className="w-16 shrink-0 pl-3">drop-off</span>
              <div className="h-6 flex-1 rounded-lg border border-dashed border-line"><div className="hatch h-full rounded-lg" style={{ width: `${(100 * f.takenAfterMatch) / f.screened}%` }} /></div>
              <b className="w-10 shrink-0 text-right text-ink">−{num(f.takenAfterMatch)}</b>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function Flow({ flow }: { flow: Summary['flow'] }) {
  const W = 900, H = 330, NW = 8, GAP = 14;
  const sum = (f: (x: Summary['flow'][number]) => boolean) => flow.filter(f).reduce((a, x) => a + x.n, 0);
  const uniq = (v: string[]) => [...new Set(v)];
  const cols = [
    uniq(flow.filter((x) => x.stage === 'm').map((x) => x.from)).map((k) => ({ k, n: sum((x) => x.stage === 'm' && x.from === k) })),
    uniq(flow.filter((x) => x.stage === 'm').map((x) => x.to)).map((k) => ({ k, n: sum((x) => x.stage === 'm' && x.to === k) })),
    uniq(flow.filter((x) => x.stage === 'o').map((x) => x.to)).map((k) => ({ k, n: sum((x) => x.stage === 'o' && x.to === k) })),
  ].map((c) => c.sort((a, b) => b.n - a.n));
  const total = Math.max(1, ...cols.map((c) => c.reduce((a, x) => a + x.n, 0)));
  const unit = (H - GAP * (Math.max(...cols.map((c) => c.length)) - 1)) / total;
  const xs = [0, 400, 700];
  const pos = cols.map((c) => { let y = 0; return new Map(c.map((x) => { const at = y; y += x.n * unit + GAP; return [x.k, { y: at, n: x.n, out: at, in: at }]; })); });
  const links = (['m', 'o'] as const).flatMap((stage, c) => {
    const order = (a: Map<string, unknown>, k: string) => [...a.keys()].indexOf(k);
    return flow.filter((x) => x.stage === stage).sort((a, b) => order(pos[c]!, a.from) - order(pos[c]!, b.from) || order(pos[c + 1]!, a.to) - order(pos[c + 1]!, b.to)).map((x) => {
      const a = pos[c]!.get(x.from)!, b = pos[c + 1]!.get(x.to)!, h = x.n * unit;
      const y0 = a.out + h / 2, y1 = b.in + h / 2, x0 = xs[c]! + NW, x1 = xs[c + 1]!, m = (x0 + x1) / 2;
      a.out += h; b.in += h;
      return <path key={stage + x.from + x.to} d={`M${x0} ${y0}C${m} ${y0} ${m} ${y1} ${x1} ${y1}`} fill="none" stroke="var(--mute)" strokeOpacity=".22" strokeWidth={Math.max(0.75, h)}><title>{`${x.from} to ${x.to}: ${x.n}`}</title></path>;
    });
  });
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 -8 ${W} ${H + 20}`} className="w-full max-w-[72rem] min-w-[46rem]" role="img" aria-label="Functions by model, route and outcome">
        {links}
        {pos.map((c, i) => [...c].map(([k, v]) => (
          <g key={i + k}>
            <rect x={xs[i]} y={v.y} width={NW} height={Math.max(1.5, v.n * unit)} fill="var(--cool)" />
            <text x={xs[i]! + NW + 6} y={v.y + Math.max(1.5, v.n * unit) / 2 + 4} fontSize="11.5" fill="var(--ink)" stroke="var(--card)" strokeWidth="3" paintOrder="stroke">{k} <tspan fill="var(--mute)">{num(v.n)}</tspan></text>
          </g>
        )))}
      </svg>
    </div>
  );
}

export function Insight({ facts }: { facts: string[] }) {
  const [i, set] = useState(0);
  const [hold, setHold] = useState(reduced());
  useEffect(() => {
    if (hold || facts.length < 2) return;
    const id = setInterval(() => set((x) => x + 1), 9000);
    return () => clearInterval(id);
  }, [hold, facts.length]);
  return (
    <div onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(reduced())}>
      <p className="min-h-16 text-base">{facts[i % facts.length] ?? '—'}</p>
      <div className="mt-3 flex items-center gap-1.5">
        {facts.map((_, k) => <button key={k} aria-label={`Fact ${k + 1}`} aria-current={k === i % facts.length} onClick={() => set(k)} className={`h-2 rounded-full ${k === i % facts.length ? 'w-5 bg-warm' : 'w-2 bg-mute/40'}`} />)}
      </div>
    </div>
  );
}
