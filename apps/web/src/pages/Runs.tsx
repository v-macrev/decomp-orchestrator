// SPDX-License-Identifier: AGPL-3.0-or-later
// Bulk-run control + live telemetry: queue depth, slots, pass/fail/retry, per-account health and
// throughput, token/cost tracking, per-function drill-down with diffs and Gate Keeper verdicts.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Flow, Task, TelemetryEvent } from '@decomp/core';
import { api, stream, type AccountView, type Batch, type Metrics, type RunSummary } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { TaskDrawer } from '../components/TaskDrawer';

const STATE_COLORS: Record<string, string> = {
  staged: 'var(--ok)', passed: 'var(--ok)', gating: 'var(--info)', leased: 'var(--accent)', pending: 'var(--muted)',
  dead: 'var(--bad)', quarantined: '#ff9e64', cancelled: 'var(--border)',
};

export default function Runs({ mode }: { mode: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const refresh = useCallback(() => api.runs().then((r) => {
    setRuns(r);
    setSel((s) => s ?? r[0]?.id ?? null);
  }), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="page" style={{ display: 'grid', gap: 14 }}>
      <div className="grid2">
        <NewRun mode={mode} onCreated={(id) => { setSel(id); refresh(); }} />
        <div className="panel">
          <h2>Runs</h2>
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Progress</th><th>Cost</th></tr></thead>
            <tbody>
              {runs.map((r) => {
                const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
                const done = (r.counts.staged ?? 0) + (r.counts.passed ?? 0) + (r.counts.dead ?? 0) + (r.counts.quarantined ?? 0);
                return (
                  <tr key={r.id} className="click" onClick={() => setSel(r.id)} style={r.id === sel ? { outline: '1px solid var(--accent)' } : undefined}>
                    <td>{r.name}<div className="muted mono" style={{ fontSize: 11 }}>{r.id}</div></td>
                    <td><span className={`chip ${r.status}`}>{r.status}</span></td>
                    <td style={{ minWidth: 120 }}><StackBar counts={r.counts} total={total} /><span className="muted" style={{ fontSize: 11 }}>{done}/{total}</span></td>
                    <td>${r.costUsd.toFixed(2)}</td>
                  </tr>
                );
              })}
              {runs.length === 0 && <tr><td colSpan={4} className="muted">No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {sel && <RunDetail key={sel} runId={sel} onChange={refresh} />}
    </div>
  );
}

function StackBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div className="bar" title={Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}>
      {Object.entries(STATE_COLORS).map(([k, c]) => (counts[k] ? <span key={k} style={{ width: `${(counts[k]! / Math.max(1, total)) * 100}%`, background: c }} /> : null))}
    </div>
  );
}

function NewRun({ mode, onCreated }: { mode: string; onCreated: (id: string) => void }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [f, setF] = useState({
    name: `run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, flowId: 'default', source: mode === 'sim' ? 'synthetic' : 'sr_next',
    count: 500, maxSize: 64, rvas: '', packetMaxFunctions: 4, gateConcurrency: 4, prBatchSize: 40, budgetUsd: '', exposureConsent: false, draftedBy: 'operator',
  });
  const [err, setErr] = useState('');
  useEffect(() => {
    api.flows().then((x) => {
      setFlows(x);
      if (x[0] && !x.some((y) => y.id === f.flowId)) setF((p) => ({ ...p, flowId: x[0]!.id }));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const selection = f.source === 'rva_list' ? { source: 'rva_list', rvas: f.rvas.split(/[\s,]+/).filter(Boolean) } : f.source === 'synthetic' ? { source: 'synthetic', count: f.count, seed: Math.floor(Math.random() * 1e6) } : { source: 'sr_next', count: f.count, maxSize: f.maxSize };
    try {
      const r = await api.createRun(f.name, f.flowId, {
        selection, packetMaxFunctions: f.packetMaxFunctions, gateConcurrency: f.gateConcurrency, prBatchSize: f.prBatchSize,
        exposureConsent: f.exposureConsent, draftedBy: f.draftedBy, ...(f.budgetUsd ? { budgetUsd: Number(f.budgetUsd) } : {}),
      });
      onCreated(r.id);
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form className="panel" onSubmit={submit} style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
      <h2>New bulk run</h2>
      <div className="row">
        <label className="grow">Name<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Flow preset<select value={f.flowId} onChange={(e) => set('flowId', e.target.value)}>{flows.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      </div>
      <div className="row">
        <label>Backlog source
          <select value={f.source} onChange={(e) => set('source', e.target.value)}>
            {mode === 'sim' ? <option value="synthetic">synthetic (simulator)</option> : <><option value="sr_next">sr next (readiness-ranked)</option><option value="rva_list">explicit RVAs</option></>}
          </select>
        </label>
        {f.source !== 'rva_list' && <label>Functions<input type="number" min={1} value={f.count} onChange={(e) => set('count', Number(e.target.value))} style={{ width: 90 }} /></label>}
        {f.source === 'sr_next' && <label>Max size (B)<input type="number" value={f.maxSize} onChange={(e) => set('maxSize', Number(e.target.value))} style={{ width: 90 }} /></label>}
      </div>
      {f.source === 'rva_list' && <label>RVAs (hex, comma/space separated)<textarea rows={3} value={f.rvas} onChange={(e) => set('rvas', e.target.value)} /></label>}
      <div className="row">
        <label>Functions / packet<input type="number" min={1} max={60} value={f.packetMaxFunctions} onChange={(e) => set('packetMaxFunctions', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Concurrent compares<input type="number" min={1} max={64} value={f.gateConcurrency} onChange={(e) => set('gateConcurrency', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Functions / PR (≤60)<input type="number" min={1} max={60} value={f.prBatchSize} onChange={(e) => set('prBatchSize', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Budget USD<input value={f.budgetUsd} placeholder="none" onChange={(e) => set('budgetUsd', e.target.value)} style={{ width: 80 }} /></label>
      </div>
      <label>Drafted by (recorded on claims)<input value={f.draftedBy} onChange={(e) => set('draftedBy', e.target.value)} /></label>
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={f.exposureConsent} onChange={(e) => set('exposureConsent', e.target.checked)} />
        <span>Send private listings (made locally from my own copy of the game) to the configured AI providers. The project requires the owner's explicit agreement; without it workers only see public repository context.</span>
      </label>
      {err && <div className="lvl-error">{err}</div>}
      <div><button className="primary" type="submit">Start run</button></div>
    </form>
  );
}

function RunDetail({ runId, onChange }: { runId: string; onChange: () => void }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState('');
  const [task, setTask] = useState<string | null>(null);

  useEffect(() => {
    api.metrics(runId).then(setM).catch(() => undefined);
    api.events(runId).then(setEvents).catch(() => undefined);
    return stream(runId, {
      metrics: setM,
      event: (e) => setEvents((xs) => [...xs.slice(-400), e]),
    });
  }, [runId]);
  useEffect(() => {
    const load = () => {
      api.tasks(runId, filter || undefined).then(setTasks).catch(() => undefined);
      api.batches(runId).then(setBatches).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [runId, filter]);

  if (!m) return <div className="panel">loading…</div>;
  const f = m.functions;
  const matched = (f.staged ?? 0) + (f.passed ?? 0);
  const done = matched + (f.dead ?? 0) + (f.quarantined ?? 0);
  const act = async (a: 'pause' | 'resume' | 'cancel', body?: unknown) => {
    await api.runAction(runId, a, body);
    onChange();
  };
  const status = m.run.status;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 className="grow" style={{ margin: 0 }}>{m.run.name} <span className={`chip ${status}`}>{status}</span></h2>
          <button onClick={() => act('pause')} disabled={status !== 'running'}>Pause</button>
          <button onClick={() => act('pause', { immediate: true })} disabled={status !== 'running'} title="Abort in-flight attempts (not counted against tasks)">Pause now</button>
          <button onClick={() => act('resume')} disabled={status !== 'paused'}>Resume</button>
          <ConfirmButton onConfirm={() => act('cancel')} disabled={['completed', 'cancelled', 'failed'].includes(status)} confirmLabel="Cancel run? Open tasks stop">Cancel</ConfirmButton>
        </div>
        {m.run.error && <div className="lvl-error">{m.run.error}</div>}
        <StackBar counts={f} total={m.totalFunctions} />
        <div className="kpis" style={{ marginTop: 12 }}>
          <Kpi l="Functions done" v={`${done}/${m.totalFunctions}`} />
          <Kpi l="Matched" v={matched} c="var(--ok)" />
          <Kpi l="Queue depth" v={m.queueDepth} />
          <Kpi l="In flight" v={(f.leased ?? 0) + (f.gating ?? 0)} />
          <Kpi l="Busy slots" v={`${m.engine.busySlots}/${m.engine.activeSlots}`} />
          <Kpi l="Dead-lettered" v={f.dead ?? 0} c="var(--bad)" />
          <Kpi l="Quarantined" v={f.quarantined ?? 0} c="#ff9e64" />
          <Kpi l="Retries" v={m.routes.retry ?? 0} />
          <Kpi l="Escalations" v={m.routes.escalate ?? 0} />
          <Kpi l="Matched / min" v={m.throughput.passedPerMin5} />
          <Kpi l="ETA" v={m.throughput.etaMinutes === null ? '—' : `${m.throughput.etaMinutes} min`} />
          <Kpi l="Cost" v={`$${m.usage.costUsd.toFixed(2)}${m.run.budgetUsd ? ` / $${m.run.budgetUsd}` : ''}`} />
          <Kpi l="Tokens in / out" v={`${fmt(m.usage.inputTokens)} / ${fmt(m.usage.outputTokens)}`} />
          <Kpi l="Provider errors" v={m.usage.providerErrors} />
        </div>
        <Sparkline series={m.throughput.series} />
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Account pool</h2>
          <AccountsTable accounts={m.accounts} usage={m.byAccount} />
        </div>
        <div className="panel">
          <h2>Live events</h2>
          <div className="log">{events.slice().reverse().map((e) => <div key={`${e.seq}-${e.ts}`} className={`lvl-${e.level}`}>{new Date(e.ts).toLocaleTimeString()} <b>{e.kind}</b> {e.msg}</div>)}</div>
        </div>
      </div>

      <div className="panel">
        <div className="row">
          <h2 className="grow">Packets</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">all states</option>
            {['pending', 'leased', 'gating', 'passed', 'staged', 'dead', 'quarantined', 'cancelled'].map((s) => <option key={s} value={s}>{s} ({m.tasks[s] ?? 0})</option>)}
          </select>
        </div>
        <table>
          <thead><tr><th>Unit</th><th>Functions</th><th>State</th><th>Tier</th><th>Attempts</th><th>Best bytes</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="click" onClick={() => setTask(t.id)}>
                <td className="mono">{t.unit.replace(/^reconstruction\//, '')}</td>
                <td>{t.functions.map((x) => x.name ?? x.rva).join(', ')}</td>
                <td><span className={`chip ${t.state}`}>{t.state}</span></td>
                <td>{t.tier}</td><td>{t.attemptsTotal}</td><td>{t.bestExactBytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {batches.length > 0 && (
        <div className="panel">
          <h2>Staged PR batches</h2>
          <p className="muted" style={{ marginTop: 0 }}>Local branches, re-verified against the combined units. Review, then submit with <span className="mono">./sr submit</span> from the branch — nothing is pushed automatically.</p>
          <table>
            <thead><tr><th>#</th><th>Status</th><th>Branch</th><th>Functions</th><th>Problems</th></tr></thead>
            <tbody>{batches.map((b) => <tr key={b.id}><td>{b.seq}</td><td><span className={`chip ${b.status === 'branch_ready' ? 'ok' : b.status === 'failed' ? 'error' : 'warn'}`}>{b.status}</span></td><td className="mono">{b.branch ?? '—'}</td><td>{b.detail?.functions ?? '?'}</td><td className="muted">{b.detail?.problems?.join('; ')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {task && <TaskDrawer taskId={task} onClose={() => setTask(null)} />}
    </div>
  );
}

export function AccountsTable({ accounts, usage }: { accounts: AccountView[]; usage?: Metrics['byAccount'] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <table>
      <thead><tr><th>Account</th><th>Status</th><th>In flight</th><th>Headroom</th><th>429s / fails</th><th>Run usage</th></tr></thead>
      <tbody>
        {accounts.map((a) => {
          const u = usage?.filter((x) => x.account_id === a.accountId) ?? [];
          const cd = a.cooldownUntil ? Math.max(0, Math.round((a.cooldownUntil - Date.now()) / 1000)) : 0;
          return (
            <tr key={a.accountId}>
              <td>{a.label}<div className="muted mono" style={{ fontSize: 11 }}>{a.provider}{a.workspace ? ` · ${a.workspace}` : ''}</div></td>
              <td><span className={`chip ${a.status}`}>{a.status}</span>{cd > 0 && <div className="muted" style={{ fontSize: 11 }}>{cd}s</div>}{a.lastError && a.status !== 'ok' && <div className="muted" style={{ fontSize: 11, maxWidth: 180 }}>{a.lastError}</div>}</td>
              <td>{a.inFlight} / {a.concurrencyLimit}<span className="muted"> (max {a.maxConcurrency})</span></td>
              <td style={{ minWidth: 90 }}>
                {(['requests', 'inputTokens', 'outputTokens'] as const).map((k) => (
                  <div key={k} className="bar" style={{ marginBottom: 2 }} title={`${k}: ${Math.round(a.headroom[k] * 100)}%`}>
                    <span style={{ width: `${Math.max(0, Math.min(1, a.headroom[k])) * 100}%`, background: a.headroom[k] > 0.3 ? 'var(--ok)' : 'var(--warn)' }} />
                  </div>
                ))}
              </td>
              <td>{a.rateLimitedTotal} / {a.failuresTotal}</td>
              <td className="muted" style={{ fontSize: 12 }}>{u.map((x) => <div key={x.model}>{x.model}: {x.attempts} att · ${Number(x.cost_usd ?? 0).toFixed(2)}</div>)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Kpi({ l, v, c }: { l: string; v: string | number; c?: string }) {
  return <div className="kpi"><div className="v" style={c ? { color: c } : undefined}>{v}</div><div className="l">{l}</div></div>;
}

function Sparkline({ series }: { series: Array<{ t: number; passed: number }> }) {
  const max = Math.max(1, ...series.map((s) => s.passed));
  const w = 600;
  const h = 48;
  const pts = series.map((s, i) => `${(i / (series.length - 1)) * w},${h - (s.passed / max) * (h - 4) - 2}`).join(' ');
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 11 }}>Matched functions per minute, last 15 min (peak {max})</div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 48 }} role="img" aria-label="Throughput sparkline">
        <polyline points={pts} fill="none" stroke="var(--ok)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
