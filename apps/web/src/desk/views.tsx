// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useState, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ActivityGrid, CumulativeStep, Donut, DotHours, Flow, Funnel, HistoryLines, Insight, ReasonBars } from './charts';
import { FunctionTable } from './functions';
import { DataTable } from './table';
import { dash, num, useFile, when, type Fn, type Hist, type State, type Summary } from './lib';
import { Card, Chip, Empty, Hint, Kpi, LimitBar, Pill, Search, StatePill } from './ui';

interface P { s: Summary; open: string | null; setOpen: (v: string | null) => void }
const ALL: State[] = ['verified', 'uncredited', 'filed', 'awaiting', 'matched', 'queued', 'claim', 'taken', 'released', 'flag'];
const d24 = (now: number, before: number) => <Pill tone={now > before ? 'cool' : 'none'}>{num(now)} in last 24 h, {num(before)} in the 24 h before</Pill>;
const was = (n: number, w: { t: number; n: number } | null) => <Pill>{w ? `${n === w.n ? 'no change' : `${n > w.n ? '+' : '−'}${num(Math.abs(n - w.n))}`} since the ${when(w.t)} run` : 'no earlier run recorded'}</Pill>;
const mono = (v: ReactNode) => <span className="font-mono text-xs">{v}</span>;

export function Overview({ s }: P) {
  const hist = useFile<Hist[]>('history', s.generatedAt);
  const k = s.kpi, n = s.notes;
  return (
    <div className="grid-fluid">
      <Kpi title="Verified matches" value={k.verified.n} how={n.verified} pill={d24(k.verified.d24, k.verified.p24)} sub={<>{num(k.verified.bytes)} B of target code, credited to {s.login}</>}
        foot={k.published ? <>Published leaderboard snapshot: {num(k.published.n)} matches, {num(k.published.bytes)} B <Hint text={n.published!} /></> : 'No leaderboard entry'} />
      <Kpi title="Filed functions" value={k.filed.n} how={n.filed} sub={`${num(k.filed.bytes)} B`} pill={<Pill>{num(k.submissionsToday)} {k.submissionsToday === 1 ? 'PR' : 'PRs'} sent today</Pill>} foot="PRs sent today counts orchestrator submissions; older PRs have no submit time on record." />
      <Kpi title="Awaiting verification or merge" value={k.awaiting.n} how={n.awaiting} sub={`${num(k.awaiting.bytes)} B`} pill={was(k.awaiting.n, k.awaiting.was)} foot={<>Plus {num(k.uncredited.n)} matched upstream without your credit <Hint text={n.uncredited!} /></>} />
      <Kpi title="Matched here, not filed" value={k.unfiled.n} how={n.matched} sub={`${num(k.unfiled.bytes)} B`} pill={<Pill>{num(k.matched.d24)} accepted in last 24 h</Pill>}
        foot={Object.entries(k.unfiled.held as Record<string, number>).map(([a, b]) => `${b} ${a.replace('_', ' ')}`).join(', ')} />
      <Kpi title="Released" value={k.released.n} how={n.release} sub={`${num(k.released.bytes)} B`} pill={was(k.released.n, k.released.was)} />
      <Kpi title="Taken by others" value={k.taken.n} pill={was(k.taken.n, k.taken.was)} sub={`${num(k.taken.bytes)} B`} foot={`${num(s.funnel.takenAfterMatch)} of these were also accepted here`} how="Local record says matched or claimed, and upstream lists the function as matched, or another open claim or pull request names it." />
      <Card title="Funnel" className="s2" how={n.funnel} foot="The drop-off row counts functions matched here that someone else matched, claimed or put in a pull request."><Funnel f={s.funnel} /></Card>
      <Card title="Limits" how={n.status}>
        <LimitBar label="Submissions today" value={k.submissionsToday} limit={s.limits.dailyLimit} note={n.dailyLimit!} />
        <LimitBar label="Awaiting verification or merge" value={k.awaiting.n} limit={s.limits.awaitingCap} note={n.awaitingCap!} />
        <LimitBar label="Functions in the largest ready batch" value={s.limits.readyBatch} limit={s.limits.prCap} note={n.prCap!} />
      </Card>
      <Card title="Insight" how="Facts computed from the collected records. No projection and no cause is stated."><Insight facts={s.facts} /></Card>
      <Card title="Cumulative verified" className="s2" how={`${n.verified} Dated by the commit that first added the function's report.`}><CumulativeStep data={s.cumulative} now={s.generatedAt} /></Card>
      <Card title="Release reasons" className="s2" how={`${n.release} The categories are described under Near misses.`}><Donut data={s.reasons} /></Card>
      <Card title="Attempts per hour of day" how={n.hours}><DotHours data={s.hours.attempts} unit="attempts" /></Card>
      <Card title="Accepted packets per hour of day" how={`Gate Keeper pass verdicts. ${n.hours}`}><DotHours data={s.hours.passes} unit="passes" /></Card>
      <Card title="Hours of the week" className="s2" how={`Attempts started, all recorded weeks added together. ${n.hours}`} foot="Square size and opacity both show the count; hover for the number."><ActivityGrid grid={s.grid} /></Card>
      <Card title="Model, route, outcome" className="s2 w3" how={`${n.modelAttr} Counts are functions.`}><Flow flow={s.flow} /></Card>
      <Card title="Pull request batches" className="s2 s3 w2" how={`${s.notes.status} Superseded batches are left out.`}>
        <table className="w-full text-xs"><thead className="text-left text-mute"><tr>{['Batch', 'Functions', 'Status', 'PR', 'Submitted', 'PR state'].map((h) => <th key={h} className="py-1 font-medium">{h}</th>)}</tr></thead>
          <tbody>{s.batches.map((b) => <tr key={b.seq} className="border-t border-line"><td className="py-1.5">{b.seq}</td><td>{num(b.functions)}</td><td>{b.status.replace('_', ' ')}</td><td>{b.pr ? b.pr.split('/').pop() : '—'}</td><td>{when(b.submittedAt)}</td><td>{dash(b.prState)}</td></tr>)}</tbody></table>
      </Card>
      <Card title="Collector history" foot="Solid: verified. Dashed: filed. Dotted: awaiting." right={<Pill>{num(s.historyRuns)} runs recorded</Pill>}>
        {hist && hist.length > 1 ? <HistoryLines data={hist} /> : <Empty>One run so far; the chart needs two.</Empty>}
      </Card>
    </div>
  );
}

export function Solved({ s, open, setOpen }: P) {
  const rows = useFile<Fn[]>('functions', s.generatedAt);
  if (!rows) return <p className="p-4 text-mute">Loading</p>;
  return <FunctionTable s={s} rows={rows} cols={['va', 'name', 'size', 'state', 'route', 'model', 'harness', 'attempts', 'near', 'last', 'verifiedAt']} initial="verifiedAt" states={ALL} open={open} setOpen={setOpen}
    foot={<><p>{s.notes.harness}</p><p>{s.notes.template}</p><p>Aligned: {s.notes.near}</p><p>Attempts: orchestrator attempts on the function's packet; outside the orchestrator, compare runs kept in its task folders.</p></>} />;
}

export function NearMisses({ s, open, setOpen }: P) {
  const all = useFile<Fn[]>('functions', s.generatedAt);
  const rows = useMemo(() => all?.filter((r) => r.state === 'released' || (r.nearAligned !== null && !r.matchedLocal && r.state !== 'verified')) ?? [], [all]);
  return (
    <div className="space-y-3.5">
      <div className="grid-few">
        <Card title="Releases by reason, functions"><ReasonBars data={s.reasons} by="count" /></Card>
        <Card title="Releases by reason, bytes" how={s.notes.bytes}><ReasonBars data={s.reasons} by="bytes" /></Card>
        <Card title="Held back or taken, functions" foot="Not releases: matched here, but set aside, withheld, or already matched upstream."><ReasonBars data={s.heldReasons} by="count" /></Card>
        <Card title="How reasons are sorted" foot="First matching rule wins, on the last verdict that names the function. Register allocation, instruction order and compile flags have rules too, but no release text names them, so they do not appear.">
          <ul className="space-y-1.5 text-xs">{s.reasons.map((r) => <li key={r.key}><b>{r.label}</b> <span className="text-mute">{r.rule}</span></li>)}</ul>
        </Card>
      </div>
      {all && <FunctionTable s={s} rows={rows} cols={['va', 'name', 'size', 'state', 'near', 'exact', 'nearReason', 'category', 'attempts', 'model', 'last']} initial="near" states={ALL} open={open} setOpen={setOpen} foot={<p>{s.notes.near}</p>} />}
    </div>
  );
}

export function Templates({ s }: P) {
  const t = useFile<any>('templates', s.generatedAt);
  const [tab, setTab] = useState<'ready' | 'offered'>('ready');
  const [text, setText] = useState('');
  const cols = useMemo<ColumnDef<any, any>[]>(() => [
    { id: 'rva', header: 'RVA', accessorKey: 'rva', size: 8, cell: (c) => mono(c.getValue()) },
    { id: 'size', header: 'Size', accessorKey: 'size', size: 5, cell: (c) => num(c.getValue()) },
    ...(tab === 'ready' ? [{ id: 'blocks', header: 'Blocks', accessorKey: 'blocks', size: 5, cell: (c: any) => num(c.getValue()) }, { id: 'unlocks', header: 'Unlocks', accessorKey: 'unlocks', size: 5, cell: (c: any) => num(c.getValue()) }]
      : [{ id: 'name', header: 'Name', accessorKey: 'name', size: 16, cell: (c: any) => dash(c.getValue()) }]),
    { id: 'claim', header: 'Open claim', accessorFn: (r: any) => r.claim?.split('/').pop() ?? null, size: 6, cell: (c) => (c.getValue() ? 'issue ' + c.getValue() : '—') },
    { id: 'yours', header: 'Your state', accessorKey: 'yours', size: 10, cell: (c) => (c.getValue() ? <StatePill s={c.getValue()} /> : '—') },
  ], [tab]);
  if (!t) return <p className="p-4 text-mute">Loading</p>;
  return (
    <div className="space-y-3.5">
      <div className="grid-few">
        <Kpi title="Your queue" value={s.kpi.queue} sub="packets pending, leased or in the Gate Keeper" foot={s.kpi.queue === 0 ? 'No run is active in the orchestrator.' : undefined} />
        <Kpi title="Ready upstream" value={t.ready.counts?.ready ?? null} sub={`${num(t.ready.counts?.listed)} listed, of ${num(t.ready.counts?.unmatched_ordinary)} unmatched`} foot={`data/ready-queue.json, progress of ${dash(t.ready.progressUpdatedAt)}`} />
        <Kpi title="Open to claim" value={t.targets.nextCandidates} sub={`${num(t.targets.underClaim)} under ${num(t.targets.claims)} open claims`} foot={`contributor-targets.json snapshot ${dash(t.targets.snapshot?.slice(0, 16))} UTC`} />
      </div>
      <div className="grid-few">
        <Card title="Template and twin ports"><Empty>{s.notes.template}</Empty></Card>
        <Card title="Upstream generator families">
          <table className="w-full text-xs"><thead className="text-left text-mute"><tr><th className="font-medium">Family</th><th>Members</th><th>Matched upstream</th><th>In your records</th></tr></thead>
            <tbody>{t.groups.map((g: any) => <tr key={g.family} className="border-t border-line"><td className="py-1.5">{g.family} v{g.version}</td><td>{num(g.members)}</td><td>{num(g.matchedUpstream)}</td><td>{num(g.yours)}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Orchestrator skills (matching recipes)" foot="Counters as stored in the skills registry.">
          <table className="w-full text-xs"><thead className="text-left text-mute"><tr><th className="font-medium">Skill</th>{['Status', 'Eligible', 'Injected', 'Passed'].map((h) => <th key={h} className="pl-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>{t.skills.map((k: any) => <tr key={k.id} className="border-t border-line"><td className="py-1.5 pr-2">{k.name}</td><td className="pl-3">{k.status}</td><td className="pl-3">{num(k.trigger_count)}</td><td className="pl-3">{num(k.inject_count)}</td><td className="pl-3">{num(k.pass_count)}</td></tr>)}</tbody></table>
        </Card>
      </div>
      <section className="card p-5">
        <div className="mb-3 flex flex-wrap gap-2"><Search value={text} onChange={setText} placeholder="Filter address or name" />
          <Chip on={tab === 'ready'} onClick={() => setTab('ready')}>Ready queue {num(t.readyEntries.length)}</Chip><Chip on={tab === 'offered'} onClick={() => setTab('offered')}>Open-function list {num(t.offered.length)}</Chip></div>
        <DataTable key={tab} data={tab === 'ready' ? t.readyEntries : t.offered} columns={cols} filter={text} rowKey={(r: any) => r.rva} height="55vh" />
      </section>
    </div>
  );
}

export function Models({ s }: P) {
  const m = useFile<any>('models', s.generatedAt);
  if (!m) return <p className="p-4 text-mute">Loading</p>;
  const rows = [...m.rows].sort((a: any, b: any) => b.matched - a.matched);
  const max = Math.max(1, ...rows.map((r: any) => r.matched));
  return (
    <div className="space-y-3.5">
      <Card title="By model and harness" how={s.notes.modelAttr} foot={s.notes.harness}>
        <div className="overflow-x-auto"><table className="w-full min-w-[52rem] text-sm">
          <thead className="text-left text-xs text-mute"><tr>{['Model', 'Harness', 'Matched', '', 'Bytes', 'Median size', 'Verified', 'Uncredited', 'Released', 'Calls'].map((h, i) => <th key={i} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r: any) => (
            <tr key={r.model + r.harness} className="border-t border-line">
              <td className="px-2 py-2">{r.model}</td><td className="px-2">{dash(r.harness)}</td><td className="px-2 font-semibold">{num(r.matched)}</td>
              <td className="w-40 px-2"><div className="h-2 rounded-full bg-soft"><div className="h-full rounded-full bg-cool" style={{ width: `${(100 * r.matched) / max}%` }} /></div></td>
              <td className="px-2">{num(r.bytes)}</td><td className="px-2">{num(r.medianSize)}</td><td className="px-2">{num(r.verified)}</td><td className="px-2">{num(r.uncredited)}</td><td className="px-2">{num(r.releases)}</td><td className="px-2">{num(r.calls)}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <div className="grid-few">
        <Card title="Tokens and time"><Empty>Token and time columns are left out for every model, because they cannot be read completely from the harnesses' own usage records.</Empty>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-mute">{m.tokens.why.map((w: string) => <li key={w}>{w}</li>)}</ul></Card>
        <Card title="Local models"><Empty>{s.notes.local}</Empty></Card>
        <Card title="Runs"><ul className="space-y-1.5 text-xs">{s.runs.map((r: any) => <li key={r.name} className="flex gap-2"><span>{r.name}</span><Pill>{r.status}</Pill><span className="ml-auto text-mute">{when(r.started_at)} to {when(r.finished_at)}</span></li>)}</ul></Card>
      </div>
    </div>
  );
}

export function Activity({ s }: P) {
  const all = useFile<{ t: number; k: string; l: string; m: string | null; run: string | null }[]>('activity', s.generatedAt);
  const [text, setText] = useState('');
  const [debug, setDebug] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const data = useMemo(() => all?.filter((a) => (debug || a.l !== 'debug') && (!group || a.k.startsWith(group + '.'))) ?? [], [all, debug, group]);
  const groups = useMemo(() => [...new Set(all?.map((a) => a.k.split('.')[0]!) ?? [])].sort(), [all]);
  const cols = useMemo<ColumnDef<any, any>[]>(() => [
    { id: 't', header: 'Time', accessorKey: 't', size: 8, enableGlobalFilter: false, cell: (c) => when(c.getValue()) },
    { id: 'l', header: 'Level', accessorKey: 'l', size: 4.5, cell: (c) => <Pill tone={c.getValue() === 'error' ? 'warm' : c.getValue() === 'warn' ? 'line' : 'none'}>{c.getValue()}</Pill> },
    { id: 'k', header: 'Event', accessorKey: 'k', size: 11, cell: (c) => mono(c.getValue()) },
    { id: 'm', header: 'Message', accessorKey: 'm', size: 45, cell: (c) => <span title={c.getValue()}>{dash(c.getValue())}</span> },
    { id: 'run', header: 'Run', accessorKey: 'run', size: 11, cell: (c) => dash(c.getValue()) },
  ], []);
  if (!all) return <p className="p-4 text-mute">Loading</p>;
  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap gap-2"><Search value={text} onChange={setText} placeholder="Search the timeline" /><Chip on={debug} onClick={() => setDebug(!debug)}>Debug events</Chip>
        {groups.map((g) => <Chip key={g} on={group === g} onClick={() => setGroup(group === g ? null : g)}>{g}</Chip>)}</div>
      <DataTable data={data} columns={cols} filter={text} rowKey={(r) => r.t + r.k} height="72vh" />
      <p className="mt-1 text-xs text-mute">{s.notes.activityFilter} Commits of yours on origin/main are included as upstream.commit.</p>
    </section>
  );
}

export function Flags({ s }: P) {
  return <div className="grid-fluid"><Card title="Flag reports" className="s2"><Empty>{s.notes.flags}</Empty></Card></div>;
}

export function Local({ s }: P) {
  return <div className="grid-fluid"><Card title="Local model" className="s2"><Empty>{s.notes.local}</Empty></Card></div>;
}
