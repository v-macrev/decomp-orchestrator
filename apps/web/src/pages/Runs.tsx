// SPDX-License-Identifier: AGPL-3.0-or-later
// Bulk-run control + live telemetry: queue depth, slots, pass/fail/retry, per-account health and
// throughput, token/cost tracking, per-function drill-down with diffs and Gate Keeper verdicts.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Flow, Task, TelemetryEvent } from '@decomp/core';
import { api, stream, type AccountView, type Batch, type CapacityPlan, type GatherPreview, type Metrics, type RoutingMetrics, type RunSkillMetrics, type RunSummary, type WorkerQuota } from '../api';
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
    routing: true, llmTieBreak: false, promoteAfter: 2, workStealing: true, contextMode: 'budgeted',
    skills: true, autoCurate: false,
    capPerWorker: 60, gMaxSize: 256, gNamespaces: '', gModules: '', gRange: '', gExcludeGuess: false, gExcludeDrafted: false,
  });
  const [err, setErr] = useState('');
  const [capacity, setCapacity] = useState<CapacityPlan | null>(null);
  const [preview, setPreview] = useState<GatherPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const gatherFilter = () => ({
    maxFunctions: f.count, maxSize: f.gMaxSize, namespaces: list(f.gNamespaces), modules: list(f.gModules),
    rvaRanges: list(f.gRange).map((r) => r.split('-')).filter((x) => x.length === 2).map(([start, end]) => ({ start: start!, end: end! })),
    excludeNameOrigins: f.gExcludeGuess ? ['GUESS'] : [], excludeDrafted: f.gExcludeDrafted,
  });
  // Live pre-run check: (worker instances × per-worker cap) vs the batch size.
  useEffect(() => {
    const flow = flows.find((x) => x.id === f.flowId);
    if (!flow || f.source === 'rva_list') return setCapacity(null);
    const t = setTimeout(() => {
      api.validateFlow(flow, { batch: f.count, cap: f.capPerWorker, stealing: f.routing && f.workStealing }).then((r) => setCapacity(r.capacity)).catch(() => setCapacity(null));
    }, 250);
    return () => clearTimeout(t);
  }, [flows, f.flowId, f.count, f.capPerWorker, f.source, f.routing, f.workStealing]);
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
    const selection = f.source === 'rva_list' ? { source: 'rva_list', rvas: f.rvas.split(/[\s,]+/).filter(Boolean) } : f.source === 'synthetic' ? { source: 'synthetic', count: f.count, seed: Math.floor(Math.random() * 1e6) } : f.source === 'gather' ? { source: 'gather', filter: gatherFilter() } : { source: 'sr_next', count: f.count, maxSize: f.maxSize };
    try {
      const r = await api.createRun(f.name, f.flowId, {
        selection, maxFunctionsPerWorker: f.capPerWorker, packetMaxFunctions: f.packetMaxFunctions, gateConcurrency: f.gateConcurrency, prBatchSize: f.prBatchSize,
        exposureConsent: f.exposureConsent, draftedBy: f.draftedBy, ...(f.budgetUsd ? { budgetUsd: Number(f.budgetUsd) } : {}),
        routing: { enabled: f.routing, llmTieBreak: f.llmTieBreak, promoteAfterFailures: f.promoteAfter, workStealing: f.workStealing },
        context: { mode: f.contextMode },
        skills: { enabled: f.skills, autoCurate: f.autoCurate },
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
            <option value="gather">gather (inventory scan + filters)</option>
          </select>
        </label>
        {f.source !== 'rva_list' && <label>Functions<input type="number" min={1} value={f.count} onChange={(e) => set('count', Number(e.target.value))} style={{ width: 90 }} /></label>}
        {f.source === 'sr_next' && <label>Max size (B)<input type="number" value={f.maxSize} onChange={(e) => set('maxSize', Number(e.target.value))} style={{ width: 90 }} /></label>}
      </div>
      {f.source === 'rva_list' && <label>RVAs (hex, comma/space separated)<textarea rows={3} value={f.rvas} onChange={(e) => set('rvas', e.target.value)} /></label>}
      {f.source === 'gather' && (
        <div style={{ display: 'grid', gap: 8, border: '1px dashed var(--border)', borderRadius: 8, padding: 10 }}>
          <div className="row">
            <label>Max size (B)<input type="number" value={f.gMaxSize} onChange={(e) => set('gMaxSize', Number(e.target.value))} style={{ width: 80 }} /></label>
            <label className="grow" title="Qualified-name prefixes on :: boundaries">Namespaces / classes<input value={f.gNamespaces} placeholder="RE, BSTArray, TESForm" onChange={(e) => set('gNamespaces', e.target.value)} /></label>
            <label className="grow" title="reconstruction/<area>/…">Modules<input value={f.gModules} placeholder="skyrim, gamebryo" onChange={(e) => set('gModules', e.target.value)} /></label>
            <label title="Half-open ranges, comma separated">RVA ranges<input value={f.gRange} placeholder="0x1000-0x2000" onChange={(e) => set('gRange', e.target.value)} style={{ width: 150 }} /></label>
          </div>
          <div className="row">
            <label className="inline"><input type="checkbox" checked={f.gExcludeGuess} onChange={(e) => set('gExcludeGuess', e.target.checked)} />Skip GUESS-named functions</label>
            <label className="inline" title="Skip functions whose unit already contains a non-trivial draft"><input type="checkbox" checked={f.gExcludeDrafted} onChange={(e) => set('gExcludeDrafted', e.target.checked)} />Skip drafted</label>
            <span className="muted" style={{ fontSize: 12 }}>Locked (claimed) and in-flight functions are always skipped.</span>
            <span className="grow" />
            <button type="button" disabled={previewing} onClick={() => { setPreviewing(true); api.gatherPreview(gatherFilter()).then(setPreview).catch((e) => setErr(String(e.message))).finally(() => setPreviewing(false)); }}>{previewing ? 'Gathering…' : 'Preview gather'}</button>
          </div>
          {preview && <GatherSummary g={preview} />}
        </div>
      )}
      <div className="row">
        <label>Functions / packet<input type="number" min={1} max={60} value={f.packetMaxFunctions} onChange={(e) => set('packetMaxFunctions', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Concurrent compares<input type="number" min={1} max={64} value={f.gateConcurrency} onChange={(e) => set('gateConcurrency', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Functions / PR (≤60)<input type="number" min={1} max={60} value={f.prBatchSize} onChange={(e) => set('prBatchSize', Number(e.target.value))} style={{ width: 80 }} /></label>
        <label>Budget USD<input value={f.budgetUsd} placeholder="none" onChange={(e) => set('budgetUsd', e.target.value)} style={{ width: 80 }} /></label>
        <label title="Hard ceiling of distinct functions one worker instance may take in this run">Max fn / worker<input type="number" min={1} max={5000} value={f.capPerWorker} onChange={(e) => set('capPerWorker', Number(e.target.value))} style={{ width: 80 }} /></label>
      </div>
      {capacity && (
        <div className={capacity.warnings.length ? 'lvl-warn' : 'muted'} style={{ fontSize: 12 }}>
          {capacity.workers} worker instance(s) × {capacity.maxPerWorker} = {capacity.capacity} function capacity for a batch of {capacity.batch}
          {capacity.warnings.length ? <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{capacity.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : ' — ok'}
        </div>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="inline"><input type="checkbox" checked={f.routing} onChange={(e) => set('routing', e.target.checked)} />Route by complexity</label>
        <label className="inline" title="Idle higher tiers pull lower-tier backlog"><input type="checkbox" checked={f.workStealing} disabled={!f.routing} onChange={(e) => set('workStealing', e.target.checked)} />Work stealing</label>
        <label className="inline" title="Borderline scores go to the Orchestrator's model (shape counts only, never listings)"><input type="checkbox" checked={f.llmTieBreak} disabled={!f.routing} onChange={(e) => set('llmTieBreak', e.target.checked)} />LLM tie-break</label>
        <label>Promote after<input type="number" min={1} max={20} value={f.promoteAfter} disabled={!f.routing} onChange={(e) => set('promoteAfter', Number(e.target.value))} style={{ width: 60 }} /></label>
        <label>Context<select value={f.contextMode} onChange={(e) => set('contextMode', e.target.value)}><option value="budgeted">budgeted bundles (v2)</option><option value="legacy">legacy bundles</option></select></label>
        <label className="inline" title="Core skills in the cached prefix + up to 2 triggered skills per attempt (frozen for the run)"><input type="checkbox" checked={f.skills} disabled={f.contextMode !== 'budgeted'} onChange={(e) => set('skills', e.target.checked)} />Skills</label>
        <label className="inline" title="When the run completes: mine, patch, optimize and shadow-evaluate skills automatically"><input type="checkbox" checked={f.autoCurate} disabled={!f.skills || f.contextMode !== 'budgeted'} onChange={(e) => set('autoCurate', e.target.checked)} />Curate after run</label>
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

      <TokenPanel m={m} />
      {m.routing && <RoutingPanel r={m.routing} knowledge={m.knowledge} />}
      {m.skills?.enabled && <RunSkillsPanel s={m.skills} />}
      {m.workers?.list.length > 0 && <WorkerQuotaPanel m={m} onChange={onChange} />}
      {m.gather && <div className="panel"><h2>Function gathering</h2><GatherSummary g={m.gather} /></div>}

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
          <thead><tr><th>Unit</th><th>Functions</th><th>Difficulty</th><th>State</th><th>Tier</th><th>Worker</th><th>Attempts</th><th>Best bytes</th></tr></thead>
          <tbody>
            {tasks.map((t) => {
              const tier = m.routing?.tiers[t.tier];
              return (
                <tr key={t.id} className="click" onClick={() => setTask(t.id)}>
                  <td className="mono">{t.unit.replace(/^reconstruction\//, '')}</td>
                  <td>{t.functions.map((x) => x.name ?? x.rva).join(', ')}</td>
                  <td><DifficultyBadge d={t.difficulty} score={t.complexity} promoted={!!t.assessment && t.assessment.difficulty !== t.difficulty} /></td>
                  <td><span className={`chip ${t.state}`}>{t.state}</span></td>
                  <td>{tier ? <><span className={`cap ${tier.capability}`}>{tier.capability}</span> <span className="muted">{t.tier}</span></> : t.tier}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{(t as { assignedWorker?: string | null }).assignedWorker ?? <span className="muted">—</span>}</td>
                  <td>{t.attemptsTotal}</td><td>{t.bestExactBytes}</td>
                </tr>
              );
            })}
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
              <td className="muted" style={{ fontSize: 12 }}>{u.map((x) => <div key={x.model}>{x.model}: {x.attempts} att · ${Number(x.cost_usd ?? 0).toFixed(2)} · cache {Math.round(Number(x.cache_hit_rate ?? 0) * 100)}%</div>)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DifficultyBadge({ d, score, promoted }: { d: string; score?: number; promoted?: boolean }) {
  return (
    <span className={`diff ${d}`} title={`${d}${score !== undefined ? ` · complexity ${score}` : ''}${promoted ? ' · promoted after failed attempts' : ''}`}>
      {d}{promoted ? ' ↑' : ''}
    </span>
  );
}

/** Token efficiency: what was sent vs. what unsliced context would have cost, and the prompt-cache share. */
function TokenPanel({ m }: { m: Metrics }) {
  const u = m.usage;
  const hit = Math.round(u.cacheHitRate * 100);
  const saved = u.contextSavedPct;
  return (
    <div className="panel">
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>Token efficiency</h2><span className="muted" style={{ fontSize: 12 }}>context: {m.run.contextMode} · routing: {m.run.routingEnabled ? 'on' : 'off'}</span></div>
      <div className="kpis" style={{ marginTop: 10 }}>
        <Kpi l="Prompt-cache hit" v={`${hit}%`} c={hit >= 40 ? 'var(--ok)' : undefined} />
        <Kpi l="Context trimmed" v={u.contextRawTokens ? `${saved}%` : '—'} c={saved >= 40 ? 'var(--ok)' : undefined} />
        <Kpi l="Saved by caching" v={`$${u.savedByCachingUsd.toFixed(2)}`} />
        <Kpi l="Cached / written" v={`${fmt(u.cacheReadTokens)} / ${fmt(u.cacheWriteTokens)}`} />
        <Kpi l="Tokens / matched fn" v={u.tokensPerMatchedFunction === null ? '—' : fmt(u.tokensPerMatchedFunction)} />
        <Kpi l="Cost / matched fn" v={u.costPerMatchedFunction === null ? '—' : `$${u.costPerMatchedFunction.toFixed(4)}`} />
      </div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <Meter label={`Input served from cache · ${fmt(u.cacheReadTokens)} of ${fmt(u.inputTokens)}`} value={u.cacheHitRate} />
        <Meter label={`Context sent vs. unsliced sources · ${fmt(u.contextTokens)} of ${fmt(u.contextRawTokens)}`} value={u.contextRawTokens ? u.contextTokens / u.contextRawTokens : 0} color="var(--accent)" />
      </div>
    </div>
  );
}

function Meter({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="meter">
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div className="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}><div className="fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, ...(color ? { background: color } : {}) }} /></div>
    </div>
  );
}

/** Where work enters the ladder, how it is moving, and what each (difficulty, tier) cell costs. */
function RoutingPanel({ r, knowledge }: { r: RoutingMetrics; knowledge: Metrics['knowledge'] }) {
  const ds = ['easy', 'medium', 'hard'] as const;
  const cell = (d: string, t: number) => r.matrix.find((x) => x.difficulty === d && x.tier === t);
  return (
    <div className="grid2">
      <div className="panel">
        <div className="row"><h2 className="grow" style={{ margin: 0 }}>Capability routing</h2>{!r.enabled && <span className="chip warn">off: all packets enter at tier 0</span>}</div>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Difficulty</th><th>Enters at</th><th>Functions</th><th>Open</th><th>Matched</th><th>Dead</th></tr></thead>
          <tbody>
            {ds.map((d) => {
              const b = r.byDifficulty[d];
              const t = r.tiers[r.route[d]];
              return (
                <tr key={d}>
                  <td><DifficultyBadge d={d} /></td>
                  <td>{t ? <><span className={`cap ${t.capability}`}>{t.capability}</span> {t.label}{r.routeSource[d] === 'edge' ? <span className="muted"> (edge rule)</span> : <span className="muted"> (nearest capability)</span>}</> : '—'}</td>
                  <td>{b.functions}</td><td>{b.open}</td><td style={{ color: 'var(--ok)' }}>{b.matched}</td><td style={{ color: b.dead ? 'var(--bad)' : undefined }}>{b.dead}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10, gap: 18 }}>
          <span><b>{r.moves.stolen ?? 0}</b> <span className="muted">stolen by idle higher tiers</span></span>
          <span><b>{r.moves.promoted ?? 0}</b> <span className="muted">promoted after failures</span></span>
          <span><b>{r.moves.rerouted ?? 0}</b> <span className="muted">re-routed by pack analysis</span></span>
          <span><b>{r.moves.escalated ?? 0}</b> <span className="muted">ladder escalations</span></span>
        </div>
      </div>
      <div className="panel">
        <h2>Attempts by difficulty × tier</h2>
        <table>
          <thead><tr><th />{r.tiers.map((t) => <th key={t.index}><span className={`cap ${t.capability}`}>{t.capability}</span></th>)}</tr></thead>
          <tbody>
            {ds.map((d) => (
              <tr key={d}>
                <td><DifficultyBadge d={d} /></td>
                {r.tiers.map((t) => {
                  const c = cell(d, t.index);
                  return <td key={t.index} className="mono" style={{ fontSize: 12 }}>{c ? <>{c.passed}/{c.attempts} pass<div className="muted">${Number(c.cost_usd ?? 0).toFixed(2)}</div></> : <span className="muted">—</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Run knowledge: {knowledge.byKind.length ? knowledge.byKind.map((k) => `${k.n} ${k.kind.replace('_', ' ')} (${k.uses} uses)`).join(' · ') : 'none yet'}
        </div>
      </div>
    </div>
  );
}

/** Per-worker quota progress against the hard per-run function cap, capacity plan and stalls. */
function WorkerQuotaPanel({ m, onChange }: { m: Metrics; onChange: () => void }) {
  const w = m.workers;
  const cap = m.capacity;
  const [raise, setRaise] = useState(w.maxPerWorker * 2);
  const used = w.list.reduce((s, x) => s + x.assigned, 0);
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Worker quotas</h2>
        <span className="muted" style={{ fontSize: 12 }}>{w.list.length} worker(s) · max {w.maxPerWorker} functions each · {used} / {w.list.length * w.maxPerWorker} assigned</span>
      </div>
      {cap?.stalled && (
        <div className="lvl-error" style={{ margin: '8px 0', fontSize: 13 }}>
          Capacity exhausted: {cap.stalled.functions} function(s) in {cap.stalled.packets} packet(s) left and every eligible worker is at its cap.{' '}
          <label className="inline" style={{ display: 'inline-flex' }}>raise to<input type="number" min={w.maxPerWorker + 1} value={raise} onChange={(e) => setRaise(Number(e.target.value))} style={{ width: 70 }} /></label>{' '}
          <button className="primary" onClick={() => api.raiseWorkerCap(m.run.id, raise).then(onChange)}>Raise cap &amp; resume</button>
        </div>
      )}
      {cap && cap.warnings.length > 0 && !cap.stalled && <ul className="lvl-warn" style={{ fontSize: 12, margin: '6px 0 6px 16px', padding: 0 }}>{cap.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
      {cap?.perTier && (
        <div className="row" style={{ gap: 14, fontSize: 12, margin: '4px 0 8px' }}>
          {cap.perTier.map((t) => (
            <span key={t.tier}><span className={`cap ${t.capability}`}>{t.capability}</span> {t.demand ?? '?'} fn → {t.workers} × {cap.maxPerWorker} = {t.capacity}{t.overflow ? <span className="lvl-warn"> (overflow {t.overflow})</span> : ''}</span>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
        {w.list.map((x) => <QuotaCard key={x.workerId} q={x} />)}
      </div>
    </div>
  );
}

function QuotaCard({ q }: { q: WorkerQuota }) {
  const pct = q.max ? q.assigned / q.max : 0;
  return (
    <div className="kpi" style={{ padding: '8px 10px' }}>
      <div className="row" style={{ gap: 6 }}>
        {q.capability && <span className={`cap ${q.capability}`}>{q.capability}</span>}
        <span className="mono grow" style={{ fontSize: 11 }}>{q.workerId}</span>
        {q.capped ? <span className="chip warn">capped</span> : q.busy ? <span className="chip running">busy</span> : <span className="chip">idle</span>}
      </div>
      <div className="meter" style={{ marginTop: 6 }}>
        <div className="mono" style={{ fontSize: 12 }}><b>{q.assigned}</b> / {q.max} functions · {q.matched} matched · {q.attempts} attempt(s)</div>
        <div className="track" role="meter" aria-label={`${q.workerId} quota`} aria-valuemin={0} aria-valuemax={q.max} aria-valuenow={q.assigned}>
          <div className="fill" style={{ width: `${Math.min(1, pct) * 100}%`, background: pct >= 1 ? 'var(--warn)' : 'var(--accent)' }} />
        </div>
      </div>
    </div>
  );
}

/** What the FunctionGatherer found and why the rest was left out. */
function GatherSummary({ g }: { g: Omit<GatherPreview, 'functions' | 'byTier'> & Partial<Pick<GatherPreview, 'functions' | 'byTier'>> }) {
  const ex = Object.entries(g.excluded).filter(([k, n]) => n && k !== 'matched').sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ fontSize: 12, display: 'grid', gap: 6 }}>
      <div><b>{g.selected}</b> function(s) in {g.units} unit(s), {g.selectedBytes} B · from {g.inventory.mapped} unmatched of {g.inventory.total} ({g.inventory.matched} matched) · <span className="muted">{g.source}{g.claimsChecked ? '' : ' · others\' claims not checked (offline)'}</span></div>
      {ex.length > 0 && <div className="muted">Excluded: {ex.map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(' · ')}</div>}
      <div className="muted">Shape: {g.withPackFeatures} with local pack counts · {g.withTableFacts} with function-table xrefs · modules {Object.entries(g.byModule).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ')}</div>
      {g.byTier && <div className="row" style={{ gap: 8 }}>{(['easy', 'medium', 'hard'] as const).map((d) => <span key={d}><DifficultyBadge d={d} /> {g.byTier![d]}</span>)}</div>}
      {g.functions && g.functions.length > 0 && (
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          <table>
            <thead><tr><th>RVA</th><th>Function</th><th>Size</th><th>Tier</th><th>Signature</th><th>Draft</th><th>Blocks</th><th>Xrefs in/out</th></tr></thead>
            <tbody>
              {g.functions.slice(0, 80).map((x) => (
                <tr key={x.rva} title={x.reasons.join(' · ')}>
                  <td className="mono">{x.rva}</td><td>{x.name}<div className="muted" style={{ fontSize: 10 }}>{x.unit}</div></td><td className="mono">{x.size}</td>
                  <td><DifficultyBadge d={x.complexityTier} score={x.complexityScore} /></td>
                  <td className="mono" style={{ fontSize: 10, maxWidth: 220 }}>{x.signature ?? <span className="muted">—</span>}</td>
                  <td>{x.draft === 'none' ? <span className="muted">—</span> : <span className={`chip ${x.draft === 'stub' ? 'warn' : ''}`}>{x.draft}</span>}</td>
                  <td className="mono">{x.basicBlocks ?? '—'}</td><td className="mono">{x.xrefsIn ?? '?'} / {x.xrefsOut ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The run's frozen skill view and what each dynamic skill did (vs. its held-out control group). */
function RunSkillsPanel({ s }: { s: Extract<RunSkillMetrics, { enabled: true }> }) {
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Skills in this run</h2>
        <span className={`chip ${s.staticPrefixes <= 1 ? 'ok' : 'warn'}`} title="Distinct static prefixes sent in this run: 1 means skills never changed the shared cache prefix">
          {s.staticPrefixes <= 1 ? 'static prefix frozen' : `${s.staticPrefixes} static prefixes`}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
        {s.core.length ? `${s.core.length} core skill(s) in the cached prefix (${s.coreTokens} tok): ${s.core.map((c) => c.name).join(' · ')}` : 'No core skills in the prefix.'} · {s.dynamic} dynamic skill(s) matched per attempt
      </div>
      {s.bySkill.length > 0 && (
        <table>
          <thead><tr><th>Skill</th><th>Packets</th><th>Injected</th><th>Held out</th><th>Pass rate (injected)</th><th>Pass rate (control)</th><th>Tokens</th></tr></thead>
          <tbody>
            {s.bySkill.map((r) => (
              <tr key={r.skillId}>
                <td>{r.name}</td><td>{r.tasks}</td><td>{r.injected}</td><td>{r.heldOut}</td>
                <td className="mono">{r.passRate === null ? '—' : `${Math.round(r.passRate * 100)}%`}</td>
                <td className="mono">{r.heldOutPassRate === null ? '—' : `${Math.round(r.heldOutPassRate * 100)}%`}</td>
                <td className="mono">{fmt(r.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
