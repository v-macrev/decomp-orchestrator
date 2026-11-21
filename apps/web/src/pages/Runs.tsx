// SPDX-License-Identifier: AGPL-3.0-or-later
// Bulk-run control + live telemetry: queue depth, slots, pass/fail/retry, per-account health and
// throughput, token/cost tracking, per-function drill-down with diffs and Gate Keeper verdicts.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Flow, Task, TelemetryEvent } from '@decomp/core';
import { api, stream, type AccountView, type Batch, type CapacityPlan, type ClaimCollision, type OperationProgress, type GatherPreview, type Metrics, type RoutingMetrics, type RunSkillMetrics, type RunSummary, type WorkerQuota } from '../api';
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
        <NewRun mode={mode} runs={runs} onCreated={(id) => { setSel(id); refresh(); }} />
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
      {sel && <RunDetail key={sel} runId={sel} onChange={refresh} onDeleted={() => { setSel(null); refresh(); }} />}
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

function flowRunDefaults(flow: Flow | undefined) {
  return {
    count: flow?.runDefaults?.functionCount ?? 500,
    capPerWorker: flow?.runDefaults?.maxFunctionsPerWorker ?? 60,
    maxSize: flow?.runDefaults?.maxSizeBytes ?? 64,
  };
}

function NewRun({ mode, runs, onCreated }: { mode: string; runs: RunSummary[]; onCreated: (id: string) => void }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [f, setF] = useState({
    name: `run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, flowId: 'default', source: mode === 'sim' ? 'synthetic' : 'sr_next',
    ...flowRunDefaults(undefined), rvas: '', packetMaxFunctions: 4, gateConcurrency: 4, prBatchSize: 40, budgetUsd: '', exposureConsent: true, draftedBy: 'operator',
    routing: true, llmTieBreak: false, promoteAfter: 2, workStealing: true, contextMode: 'budgeted',
    skills: true, autoCurate: false, staging: mode === 'sim' ? 'branches' : 'off',
    gMaxSize: 256, gNamespaces: '', gModules: '', gRange: '', gExcludeGuess: false, gExcludeDrafted: false,
  });
  const [err, setErr] = useState('');
  // "Carry the failed functions": earlier runs whose dead packets join this run.
  const [carryFrom, setCarryFrom] = useState<string[]>([]);
  const withDead = runs.filter((r) => (r.counts.dead ?? 0) > 0 && ['completed', 'cancelled', 'failed'].includes(r.status));
  const carried = withDead.filter((r) => carryFrom.includes(r.id)).reduce((s, r) => s + (r.counts.dead ?? 0), 0);
  useEffect(() => {
    api.health().then((h) => { if (h.runDefaults?.draftedBy) setF((p) => (p.draftedBy === 'operator' ? { ...p, draftedBy: h.runDefaults!.draftedBy! } : p)); }).catch(() => undefined);
  }, []);
  const [capacity, setCapacity] = useState<CapacityPlan | null>(null);
  const [preview, setPreview] = useState<GatherPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [availability, setAvailability] = useState<{ requested: number; selected: number; units: number; maxSize: number } | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const gatherFilter = () => ({
    maxFunctions: f.count, maxSize: f.gMaxSize, namespaces: list(f.gNamespaces), modules: list(f.gModules),
    rvaRanges: list(f.gRange).map((r) => r.split('-')).filter((x) => x.length === 2).map(([start, end]) => ({ start: start!, end: end! })),
    excludeNameOrigins: f.gExcludeGuess ? ['GUESS'] : [], excludeDrafted: f.gExcludeDrafted,
  });
  // Live pre-run check: (worker instances × per-worker cap) vs the batch size.
  useEffect(() => {
    const flow = flows.find((x) => x.id === f.flowId);
    if (!flow || f.source === 'rva_list' || f.source === 'carry') return setCapacity(null);
    const t = setTimeout(() => {
      api.validateFlow(flow, { batch: f.count, cap: f.capPerWorker, stealing: f.routing && f.workStealing }).then((r) => setCapacity(r.capacity)).catch(() => setCapacity(null));
    }, 250);
    return () => clearTimeout(t);
  }, [flows, f.flowId, f.count, f.capPerWorker, f.source, f.routing, f.workStealing]);
  useEffect(() => {
    api.flows().then((x) => {
      setFlows(x);
      setF((p) => {
        const flow = x.find((y) => y.id === p.flowId) ?? x[0];
        return flow ? { ...p, flowId: flow.id, ...(flow.runDefaults ? flowRunDefaults(flow) : {}) } : p;
      });
    });
  }, []);
  const set = (k: keyof typeof f, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const selectFlow = (id: string) => {
    const flow = flows.find((x) => x.id === id);
    const leavingPreset = flows.find((x) => x.id === f.flowId)?.runDefaults;
    setF((p) => ({ ...p, flowId: id, ...(flow?.runDefaults || leavingPreset ? flowRunDefaults(flow) : {}) }));
  };
  const checkAvailability = async () => {
    setErr('');
    setAvailability(null);
    setCheckingAvailability(true);
    try {
      const result = await api.selectionPreview(f.count, f.maxSize);
      setAvailability({ ...result, maxSize: f.maxSize });
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setCheckingAvailability(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const carryOn = carryFrom.filter((id) => withDead.some((r) => r.id === id));
    if (f.source === 'carry' && !carryOn.length) return setErr('Pick at least one earlier run to carry failed functions from.');
    const selection = f.source === 'carry' ? null : f.source === 'rva_list' ? { source: 'rva_list', rvas: f.rvas.split(/[\s,]+/).filter(Boolean) } : f.source === 'synthetic' ? { source: 'synthetic', count: f.count, seed: Math.floor(Math.random() * 1e6) } : f.source === 'gather' ? { source: 'gather', filter: gatherFilter() } : { source: 'sr_next', count: f.count, maxSize: f.maxSize };
    try {
      const r = await api.createRun(f.name, f.flowId, {
        ...(selection ? { selection } : {}), ...(carryOn.length ? { carry: { fromRuns: carryOn } } : {}), maxFunctionsPerWorker: f.capPerWorker, staging: f.staging, packetMaxFunctions: f.packetMaxFunctions, gateConcurrency: f.gateConcurrency, prBatchSize: f.prBatchSize,
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
        <label>Flow preset<select value={f.flowId} onChange={(e) => selectFlow(e.target.value)}>{flows.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      </div>
      <div className="row">
        <label>Backlog source
          <select value={f.source} onChange={(e) => set('source', e.target.value)}>
            {mode === 'sim' ? <option value="synthetic">synthetic (simulator)</option> : <><option value="sr_next">sr next (readiness-ranked)</option><option value="rva_list">explicit RVAs</option></>}
            <option value="gather">gather (inventory scan + filters)</option>
            <option value="carry">only failed functions carried over (below)</option>
          </select>
        </label>
        {!['rva_list', 'carry'].includes(f.source) && <label>Functions<input type="number" min={1} value={f.count} onChange={(e) => set('count', Number(e.target.value))} style={{ width: 90 }} /></label>}
        {f.source === 'sr_next' && <label>Max size (B)<input type="number" value={f.maxSize} onChange={(e) => set('maxSize', Number(e.target.value))} style={{ width: 90 }} /></label>}
        {f.source === 'sr_next' && <button type="button" onClick={checkAvailability} disabled={checkingAvailability}>{checkingAvailability ? 'Checking upstream…' : 'Check availability'}</button>}
      </div>
      {f.source === 'sr_next' && availability?.requested === f.count && availability.maxSize === f.maxSize && (
        <div role="status" className={availability.selected < f.count ? 'lvl-warn' : 'muted'}>
          {availability.selected} of {availability.requested} requested functions eligible across {availability.units} source units after checking upstream.
        </div>
      )}
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
        <label title="Off: nothing is committed in the target repository and every claim is released at the end">Staging<select value={f.staging} onChange={(e) => set('staging', e.target.value)}><option value="off">off (no commits)</option><option value="branches">local branches</option></select></label>
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
      {withDead.length > 0 && (
        <div style={{ display: 'grid', gap: 4, border: '1px dashed var(--border)', borderRadius: 8, padding: 10 }}>
          <span title="Their dead packets' functions are added to this run's selection (or are the whole run with the source above set to carried-only)">Carry failed functions from earlier runs{carried ? ` — ${carried} function(s)` : ''}</span>
          {withDead.map((r) => (
            <label key={r.id} className="inline">
              <input type="checkbox" checked={carryFrom.includes(r.id)} onChange={(e) => setCarryFrom((xs) => (e.target.checked ? [...xs, r.id] : xs.filter((x) => x !== r.id)))} />
              {r.name} <span className="muted">· {r.counts.dead} dead{(r.config.carry as { fromRuns?: string[] } | undefined)?.fromRuns?.length ? ' · itself a carry-over' : ''}</span>
            </label>
          ))}
        </div>
      )}
      <label>Drafted by (claims, commits and <span className="mono">sr submit --drafted-by</span>)<input value={f.draftedBy} onChange={(e) => set('draftedBy', e.target.value)} /></label>
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={f.exposureConsent} onChange={(e) => set('exposureConsent', e.target.checked)} />
        <span>Send private listings (made locally from my own copy of the game) to the configured AI providers. The project requires the owner's explicit agreement; without it workers only see public repository context.</span>
      </label>
      {err && <div className="lvl-error">{err}</div>}
      <div><button className="primary" type="submit">Start run</button></div>
    </form>
  );
}

function RunDetail({ runId, onChange, onDeleted }: { runId: string; onChange: () => void; onDeleted: () => void }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState('');
  const [task, setTask] = useState<string | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryFailedError, setRetryFailedError] = useState('');
  const [retryFailedMessage, setRetryFailedMessage] = useState('');
  const [editing, setEditing] = useState(false);

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
  const retryFailed = async () => {
    setRetryFailedError('');
    setRetryFailedMessage('');
    setRetryingFailed(true);
    try {
      const result = await api.retryFailedTasks(runId);
      setRetryFailedMessage(result.requeued
        ? `Requeued ${result.requeued} failed packet(s) at ${result.tierLabel}.`
        : 'There are no dead packets to retry.');
      onChange();
    } catch (e) {
      setRetryFailedError((e as Error).message);
    } finally {
      setRetryingFailed(false);
    }
  };
  const removeRun = async () => {
    setRetryFailedError('');
    try {
      await api.deleteRun(runId);
      onDeleted();
    } catch (e) {
      setRetryFailedError((e as Error).message);
    }
  };
  const applyFlow = async () => {
    setRetryFailedError('');
    setRetryFailedMessage('');
    try {
      await api.applyRunFlow(runId);
      setRetryFailedMessage('Flow template applied: new attempts use it; attempts already running finish as they started.');
      onChange();
    } catch (e) {
      setRetryFailedError((e as Error).message);
    }
  };
  const status = m.run.status;
  const selectionShortfall = events.find((event) => event.kind === 'run.selection_shortfall');
  const deadTasks = m.tasks.dead ?? 0;
  const retryUnavailable = ['cancelled', 'failed', 'created', 'discovering'].includes(status)
    || (m.run.budgetUsd !== null && m.run.costUsd >= m.run.budgetUsd);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 className="grow" style={{ margin: 0 }}>{m.run.name} <span className={`chip ${status}`}>{status}</span></h2>
          <button onClick={() => act('pause')} disabled={status !== 'running'}>Pause</button>
          <button onClick={() => act('pause', { immediate: true })} disabled={status !== 'running'} title="Abort in-flight attempts (not counted against tasks)">Pause now</button>
          <button onClick={() => act('resume')} disabled={status !== 'paused' || (m.run.budgetUsd !== null && m.run.costUsd >= m.run.budgetUsd)} title={m.run.budgetUsd !== null && m.run.costUsd >= m.run.budgetUsd ? 'Budget reached: set a new budget below to resume' : undefined}>Resume</button>
          <ConfirmButton onConfirm={retryFailed} disabled={!deadTasks || retryingFailed || retryUnavailable} className="primary" confirmLabel={`Retry ${deadTasks} failed task(s) where each stopped?`} title="Retries only dead packets; successful and quarantined tasks are left alone. Retries use this run's remaining budget.">{retryingFailed ? 'Retrying…' : `Retry failed tasks (${deadTasks})`}</ConfirmButton>
          <ConfirmButton onConfirm={() => act('cancel')} disabled={['completed', 'cancelled', 'failed'].includes(status)} confirmLabel="Cancel run? Open tasks stop">Cancel</ConfirmButton>
          <button onClick={() => setEditing((x) => !x)}>{editing ? 'Close edit' : 'Edit'}</button>
          <ConfirmButton onConfirm={applyFlow} disabled={['completed', 'cancelled', 'failed'].includes(status)} confirmLabel="Apply the flow template's current models and limits to this run?" title="Re-reads this run's flow template: models, capability, attempts and checks change from the next attempt on. Worker counts, tiers and routing stay as the run started.">Apply flow changes</ConfirmButton>
          <ConfirmButton onConfirm={removeRun} disabled={m.engine.active || ['running', 'discovering'].includes(status)} confirmLabel="Delete run and its history? Claims go back" title={m.engine.active ? 'Cancel or finish the run first' : 'Deletes the run, its packets, attempts and events; local claims it still holds are released (not those in a submitted PR)'}>Delete</ConfirmButton>
        </div>
        {editing && <RunEditor runId={runId} status={status} onSaved={() => { setEditing(false); onChange(); api.metrics(runId).then(setM).catch(() => undefined); }} />}
        {retryFailedError && <div className="lvl-error">{retryFailedError}</div>}
        {retryFailedMessage && <div className="muted" role="status">{retryFailedMessage}</div>}
        {deadTasks > 0 && <div className="muted" style={{ fontSize: 12 }}>Retrying starts dead packets at the fast tier. Passed packets remain complete; quarantined packets still need individual review.</div>}
        {m.run.error && <div className="lvl-error">{m.run.error}</div>}
        {selectionShortfall && <div className="lvl-warn" role="status">{selectionShortfall.msg}</div>}
        {status === 'paused' && m.run.budgetUsd !== null && m.run.costUsd >= m.run.budgetUsd && <BudgetPausedBanner m={m} onChange={onChange} />}
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
            {['pending', 'leased', 'gating', 'passed', 'staged', 'withheld', 'set_aside', 'dead', 'quarantined', 'cancelled'].map((s) => <option key={s} value={s}>{s} ({m.tasks[s] ?? 0})</option>)}
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

      {(batches.length > 0 || (status === 'completed' && (m.tasks.passed ?? 0) > 0)) && (
        <BatchesPanel runId={runId} status={status} passed={m.tasks.passed ?? 0} withheld={m.tasks.withheld ?? 0} setAside={m.tasks.set_aside ?? 0} batches={batches} reload={() => api.batches(runId).then(setBatches).catch(() => undefined)} />
      )}
      {task && <TaskDrawer taskId={task} onClose={() => setTask(null)} />}
    </div>
  );
}

/** Name, drafted-by and the settings that can still change on an existing run. */
function RunEditor({ runId, status, onSaved }: { runId: string; status: string; onSaved: () => void }) {
  const [v, setV] = useState<{ name: string; draftedBy: string; budgetUsd: string; prBatchSize: number; staging: 'branches' | 'off' } | null>(null);
  const [orig, setOrig] = useState<typeof v>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.runs().then((rs) => {
      const r = rs.find((x) => x.id === runId);
      if (!r) return;
      const c = r.config as { draftedBy?: string; budgetUsd?: number; prBatchSize?: number; staging?: 'branches' | 'off' };
      const init = { name: r.name, draftedBy: c.draftedBy ?? 'operator', budgetUsd: c.budgetUsd === undefined ? '' : String(c.budgetUsd), prBatchSize: c.prBatchSize ?? 40, staging: c.staging ?? 'branches' };
      setV(init);
      setOrig(init);
    }).catch((e) => setErr((e as Error).message));
  }, [runId]);
  if (!v || !orig) return <div className="muted">loading…</div>;
  const finished = ['completed', 'cancelled', 'failed'].includes(status);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    const patch: Parameters<typeof api.updateRun>[1] = {};
    if (v.name.trim() !== orig.name) patch.name = v.name.trim();
    if (v.draftedBy.trim() !== orig.draftedBy) patch.draftedBy = v.draftedBy.trim();
    if (v.budgetUsd.trim() !== orig.budgetUsd) patch.budgetUsd = v.budgetUsd.trim() ? Number(v.budgetUsd) : null;
    if (v.prBatchSize !== orig.prBatchSize) patch.prBatchSize = v.prBatchSize;
    if (v.staging !== orig.staging) patch.staging = v.staging;
    if (patch.budgetUsd !== undefined && patch.budgetUsd !== null && !(patch.budgetUsd > 0)) return setErr('Budget must be a positive number, or empty for none.');
    setSaving(true);
    try {
      if (Object.keys(patch).length) await api.updateRun(runId, patch);
      onSaved();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} style={{ display: 'grid', gap: 8, border: '1px dashed var(--border)', borderRadius: 8, padding: 10, margin: '6px 0 10px' }}>
      <div className="row">
        <label className="grow">Name<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <label className="grow" title="Used on claims, commit messages and sr submit --drafted-by from now on; this run's earlier Drafted-by lines are renamed when its functions are batched or submitted">Drafted by<input value={v.draftedBy} onChange={(e) => setV({ ...v, draftedBy: e.target.value })} /></label>
      </div>
      <div className="row">
        <label>Budget USD<input value={v.budgetUsd} placeholder="none" onChange={(e) => setV({ ...v, budgetUsd: e.target.value })} style={{ width: 80 }} /></label>
        <label>Functions / PR (≤60)<input type="number" min={1} max={60} value={v.prBatchSize} onChange={(e) => setV({ ...v, prBatchSize: Number(e.target.value) })} style={{ width: 80 }} /></label>
        <label title={finished ? 'Decided when the run finished; batch passed functions from the PR batches panel instead' : 'What happens to matched functions when the run finishes'}>Staging
          <select value={v.staging} disabled={finished} onChange={(e) => setV({ ...v, staging: e.target.value as 'branches' | 'off' })}><option value="off">off (no commits)</option><option value="branches">local branches</option></select>
        </label>
        <span className="grow" />
        <button className="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {err && <div className="lvl-error">{err}</div>}
    </form>
  );
}

const CLAIM_LAPSE_MS = 24 * 3600_000;
const issueNo = (url: string) => `#${/\/(\d+)$/.exec(url)?.[1] ?? url}`;
const fmtDuration = (ms: number) => {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
/** When a claim stops blocking if nobody touches it (sr: a day without activity). */
const lapseText = (c: ClaimCollision, now = Date.now()) => {
  if (!c.updatedAt) return '';
  const left = Date.parse(c.updatedAt) + CLAIM_LAPSE_MS - now;
  return left <= 0 ? 'lapsed: recheck' : `lapses in ${fmtDuration(left)} unless renewed`;
};

type StepState = 'done' | 'blocked' | 'next' | 'todo';

/** Where a batch is on staged → claims → dry run → PR, and the one thing to do next. */
function batchProgress(b: Batch): { steps: Array<{ label: string; state: StepState; title: string }>; next: string; tone: 'muted' | 'lvl-warn' | 'lvl-error' } {
  const d = b.detail;
  const last = d?.lastSubmit;
  const collisions = d?.claimCheck ? Object.keys(d.claimCheck.collisions).length : null;
  const claimBlockers = last?.blockers.filter((x) => /another open claim or pull request/i.test(x)).length ?? 0;
  const otherBlockers = (last?.blockers.length ?? 0) - claimBlockers;
  const cleanDry = !!d?.dryRunFingerprint && !(d?.dryRunUncheckedClaims ?? []).length;
  const steps: Array<{ label: string; state: StepState; title: string }> = [];
  steps.push(b.status === 'failed'
    ? { label: 'Staging failed', state: 'blocked', title: 'Re-verification in a clean tree failed: no branch was created and the packets stay passed' }
    : { label: 'Staged', state: 'done', title: 'Re-verified in a clean tree and committed to a local branch' });
  const claimsChecked = d?.claimCheck ? ` (checked ${new Date(d.claimCheck.at).toLocaleTimeString()})` : '';
  steps.push(collisions === null
    ? claimBlockers
      ? { label: `${claimBlockers} claimed`, state: 'blocked', title: 'The last dry run found functions another contributor has claimed' }
      : { label: 'Claims ?', state: 'todo', title: 'Not checked against other contributors\' open claims yet (Drop colliding packets checks; a dry run checks too)' }
    : collisions
      ? { label: `${collisions} claimed`, state: 'blocked', title: `Other contributors' open claims or PRs name ${collisions} function(s)${claimsChecked}` }
      : { label: 'Claims clear', state: 'done', title: `No other open claim or PR names these functions${claimsChecked}` });
  steps.push(cleanDry
    ? { label: 'Dry run clean', state: 'done', title: 'sr submit --dry-run passed for exactly this batch' }
    : last?.dryRun && !last.cancelled && !last.ok
      ? { label: 'Dry run failed', state: 'blocked', title: 'The last dry run found problems (listed in the row)' }
      : { label: 'Dry run', state: 'todo', title: 'Not dry-run yet (needed before Submit PR)' });
  steps.push(b.status === 'submitted'
    ? { label: 'PR open', state: 'done', title: d?.pr ?? '' }
    : { label: 'PR', state: 'todo', title: 'Submit PR becomes available after a clean dry run' });

  if (b.status === 'submitted') return { steps, next: 'Done: the pull request is open.', tone: 'muted' };
  if (b.status === 'draft') {
    steps[0] = { label: 'Re-verifying…', state: 'next', title: 'Being re-verified in a clean tree now' };
    return { steps, tone: 'lvl-warn', next: 'Being re-verified now: see the progress above.' };
  }
  if (b.status === 'interrupted') {
    steps[0] = { label: 'Interrupted', state: 'blocked', title: 'A server restart stopped its re-verification: no branch was created and its packets stay passed' };
    return { steps, tone: 'lvl-error', next: 'A server restart interrupted its re-verification (nothing was committed). Next: Re-verify again.' };
  }
  if (b.status === 'superseded') {
    const held = [d?.withheld ? `${d.withheld.taskIds.length} packet(s) withheld for claims` : '', d?.setAside ? `${d.setAside.taskIds.length} packet(s) set aside (${d.setAside.why})` : ''].filter(Boolean).join(', ');
    return { steps, tone: 'muted', next: `Replaced: ${held || 'its packets were re-verified again'}${d?.supersededBy?.length ? `; the rest moved to batch ${d.supersededBy.join(', ')}` : ''}. Nothing to do here.` };
  }
  if (b.status === 'failed') return { steps, tone: 'lvl-error', next: 'Its packets stay passed. Next: Re-verify again (or Re-verify failed batches above). Packets that still fail end up in a new failed batch on their own.' };
  const mark = (i: number) => {
    if (steps[i]!.state === 'todo') steps[i]!.state = 'next';
  };
  if (collisions || (collisions === null && claimBlockers)) {
    return { steps, tone: 'lvl-error', next: 'Next: Drop colliding packets (or Drop colliding packets in all batches). sr submit refuses a PR with claimed functions.' };
  }
  if (last?.dryRun && !last.cancelled && !last.ok && !cleanDry) {
    return { steps, tone: 'lvl-error', next: otherBlockers || last.problems.length ? 'Next: Set aside blocking units. It holds the units these findings name out of PRs and re-verifies the rest as a new batch.' : 'Dry run found problems (listed in the row): run it again after they are resolved.' };
  }
  if (!cleanDry) {
    if (collisions === null) mark(1);
    mark(2);
    return { steps, tone: 'lvl-warn', next: collisions === null ? 'Next: Dry run (it checks claims too), or Drop colliding packets to check claims first.' : 'Next: Dry run. Submit PR unlocks when it is clean.' };
  }
  mark(3);
  return { steps, tone: 'lvl-warn', next: 'Next: Submit PR.' };
}

function BatchProgress({ b }: { b: Batch }) {
  const p = batchProgress(b);
  return (
    <div>
      <div className="steps">{p.steps.map((s) => <span key={s.label} className={`step ${s.state}`} title={s.title}>{s.state === 'done' ? '✓ ' : s.state === 'blocked' ? '✕ ' : ''}{s.label}</span>)}</div>
      <div className={`next-hint ${p.tone}`}>{p.next}</div>
    </div>
  );
}

/** The batch's functions by unit, with the claims that name them: a claimed function holds back its whole unit. */
function BatchFunctions({ b }: { b: Batch }) {
  const collisions = b.detail?.claimCheck?.collisions ?? {};
  const checked = !!b.detail?.claimCheck;
  const units = new Map<string, Batch['functions']>();
  for (const f of b.functions) units.set(f.unit, [...(units.get(f.unit) ?? []), f]);
  return (
    <table className="fns">
      <thead><tr><th>Function</th><th>Packet now</th><th>Other contributors' claims</th></tr></thead>
      <tbody>
        {[...units].map(([unit, fns]) => {
          const hit = fns.some((f) => collisions[f.rva]);
          return [
            <tr key={unit} className={`unit-row${hit ? ' unit-hit' : ''}`}>
              <td colSpan={3}>{unit}{hit && <span className="chip error" style={{ marginLeft: 6 }}>{fns.every((f) => f.state === 'withheld') ? 'unit withheld' : 'claimed: the whole unit is held back'}</span>}</td>
            </tr>,
            ...fns.map((f) => (
              <tr key={`${unit}-${f.rva}`} className={hit ? 'unit-hit' : ''}>
                <td><span className="mono">{f.rva}</span> {f.name ?? ''}</td>
                <td><span className={`chip ${f.state}`}>{f.state}</span></td>
                <td>
                  {collisions[f.rva]
                    ? collisions[f.rva]!.map((c) => <div key={c.url}><a href={c.url} target="_blank" rel="noreferrer">{issueNo(c.url)}</a> {c.author ?? ''} <span className="muted">· {lapseText(c)}</span></div>)
                    : <span className="muted">{checked ? (hit ? 'clear (held back with its unit)' : '✓ clear') : 'not checked'}</span>}
                </td>
              </tr>
            )),
          ];
        })}
      </tbody>
    </table>
  );
}

/** Withheld functions across the run, by unit, with who holds the claims and when they lapse. */
function WithheldList({ batches }: { batches: Batch[] }) {
  // A packet can be withheld, returned and withheld again: the latest batch that withheld it knows its claims.
  const seen = new Set<string>();
  const rows = [...batches].sort((x, y) => y.seq - x.seq).flatMap((b) => b.functions
    .filter((f) => f.state === 'withheld' && !seen.has(`${f.taskId}:${f.rva}`) && seen.add(`${f.taskId}:${f.rva}`))
    .map((f) => ({ ...f, claims: b.detail?.claimCheck?.collisions[f.rva] ?? [] })));
  if (!rows.length) return null;
  const units = new Map<string, typeof rows>();
  for (const r of rows) units.set(r.unit, [...(units.get(r.unit) ?? []), r]);
  const lapses = rows.flatMap((r) => r.claims).map((c) => (c.updatedAt ? Date.parse(c.updatedAt) + CLAIM_LAPSE_MS : NaN)).filter((t) => !Number.isNaN(t));
  const soonest = lapses.length ? Math.min(...lapses) : null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary><b>{rows.length} withheld function(s)</b> in {units.size} unit(s){soonest ? <span className="muted"> · first claim {soonest <= Date.now() ? 'has lapsed: Recheck withheld' : `lapses in ${fmtDuration(soonest - Date.now())}`}</span> : null}</summary>
      <p className="muted" style={{ margin: '4px 0' }}>These passed but are held out of every PR because another contributor's open claim or PR names a function in their unit. They keep your local claims. <b>Recheck withheld</b> batches every unit whose claims have lapsed or closed.</p>
      <table className="fns">
        <thead><tr><th>Function</th><th>Claims</th></tr></thead>
        <tbody>
          {[...units].map(([unit, fns]) => [
            <tr key={unit} className="unit-row"><td colSpan={2}>{unit}</td></tr>,
            ...fns.map((f) => (
              <tr key={`${unit}-${f.rva}`}>
                <td><span className="mono">{f.rva}</span> {f.name ?? ''}</td>
                <td>{f.claims.length
                  ? f.claims.map((c) => <div key={c.url}><a href={c.url} target="_blank" rel="noreferrer">{issueNo(c.url)}</a> {c.author ?? ''} <span className="muted">· {lapseText(c)}</span></div>)
                  : <span className="muted">held back with its unit</span>}</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </details>
  );
}

/** Ticks every second while mounted, so elapsed times stay live. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The server's slot-holding operation, live: current step, its progress, and the steps already done. */
function OperationPanel({ op, runId }: { op: OperationProgress; runId: string }) {
  const now = useNow(true);
  const pct = op.total ? Math.min(100, Math.round(((op.done ?? 0) / op.total) * 100)) : null;
  const other = op.runId && op.runId !== runId;
  return (
    <div className="op-panel" role="status" aria-live="polite">
      <div className="op-head">
        <span className="spinner" aria-hidden="true" />
        <div className="grow">
          <div className="op-step">{op.step}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {other ? `Another run holds the worktree slots: ${op.label}. ` : ''}
            running for {fmtDuration(now - op.startedAt)}{op.step !== op.label ? ` · this step ${fmtDuration(now - op.stepStartedAt)}` : ''}
            {op.total ? ` · ${op.done ?? 0} of ${op.total} done` : ''}
          </div>
        </div>
      </div>
      {op.detail && <div className="op-detail">{op.detail}</div>}
      {pct !== null && <div className="bar"><span style={{ width: `${pct}%`, background: 'var(--accent)' }} /></div>}
      {op.log.length > 0 && (
        <ol start={Math.max(1, op.log.length - 5)}>
          {op.log.slice(-6).map((l) => <li key={`${l.at}-${l.step}`}>✓ {l.step} <span>({fmtDuration(l.ms)})</span></li>)}
        </ol>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Runs on the server: you can leave or reload this page. Batch buttons wait until it finishes.</div>
    </div>
  );
}

/** Set-aside units across the run, with the findings that blocked each, and Put back. */
function SetAsideList({ batches, locked, busy, putBack }: { batches: Batch[]; locked: boolean; busy: string | null; putBack: (units?: string[]) => void }) {
  // The latest batch that set a unit aside knows why.
  const units = new Map<string, { reasons: string[]; fns: Batch['functions']; seq: number }>();
  for (const b of [...batches].sort((x, y) => y.seq - x.seq)) {
    const sa = b.detail?.setAside;
    if (!sa) continue;
    for (const unit of sa.units) {
      if (units.has(unit)) continue;
      const fns = b.functions.filter((f) => f.unit === unit && f.state === 'set_aside');
      if (fns.length) units.set(unit, { reasons: sa.reasons[unit] ?? [], fns, seq: b.seq });
    }
  }
  if (!units.size) return null;
  return (
    <details className="attention-list">
      <summary><b>{[...units.values()].reduce((n, u) => n + u.fns.length, 0)} function(s) set aside</b> in {units.size} unit(s)</summary>
      <p className="muted" style={{ margin: '4px 0' }}>Held out of every PR: each blocked a dry run, or upstream already has it. Upstream's work stays untouched. <b>Put back</b> once the cause is gone (e.g. upstream added the missing origin statements); it re-verifies the unit into a new batch.</p>
      <table className="fns">
        <thead><tr><th>Unit</th><th>Why</th><th /></tr></thead>
        <tbody>
          {[...units].map(([unit, u]) => (
            <tr key={unit}>
              <td><div className="mono" style={{ fontSize: 12 }}>{unit}</div><div className="muted" style={{ fontSize: 11 }}>{u.fns.map((f) => f.rva).join(', ')} · from batch {u.seq}</div></td>
              <td style={{ fontSize: 12 }}>
                {u.reasons.slice(0, 3).map((r) => <div key={r}>{r}</div>)}
                {u.reasons.length > 3 && <details><summary className="muted">{u.reasons.length - 3} more</summary>{u.reasons.slice(3).map((r) => <div key={r}>{r}</div>)}</details>}
              </td>
              <td><button disabled={locked} onClick={() => putBack([unit])}>{busy === 'put-back' ? 'Putting back…' : 'Put back'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {units.size > 1 && <div style={{ marginTop: 6 }}><ConfirmButton disabled={locked} onConfirm={() => putBack()} confirmLabel={`Put all ${units.size} set-aside units back and re-verify them?`}>Put all back</ConfirmButton></div>}
    </details>
  );
}

/** How many batches stand at each step. */
function BatchPipeline({ batches, withheld, setAside }: { batches: Batch[]; withheld: number; setAside: number }) {
  const live = batches.filter((b) => b.status === 'branch_ready');
  const claimed = live.filter((b) => batchProgress(b).steps[1]!.state === 'blocked').length;
  const clear = live.filter((b) => b.detail?.claimCheck && !Object.keys(b.detail.claimCheck.collisions).length).length;
  const clean = live.filter((b) => !!b.detail?.dryRunFingerprint && !(b.detail.dryRunUncheckedClaims ?? []).length).length;
  const submitted = batches.filter((b) => b.status === 'submitted').length;
  const failed = batches.filter((b) => b.status === 'failed').length;
  const fns = (list: Batch[]) => list.reduce((n, b) => n + b.functions.length, 0);
  const stage = (n: number | string, label: string, title: string, tone = '') => (
    <div className="stage" title={title}><b className={tone}>{n}</b><span>{label}</span></div>
  );
  return (
    <div className="pipeline">
      {stage(live.length, `staged batch(es) · ${fns(live)} fns`, 'Batches with a re-verified local branch, not submitted yet')}
      <span className="arrow">→</span>
      {stage(claimed ? `${claimed} ✕` : clear, claimed ? 'claimed by others' : 'claims clear', claimed ? 'Batches where other contributors claimed some functions: Drop colliding packets' : 'Batches checked with no colliding claims', claimed ? 'lvl-error' : '')}
      <span className="arrow">→</span>
      {stage(clean, 'clean dry run', 'Batches whose dry run passed: Submit PR is available')}
      <span className="arrow">→</span>
      {stage(submitted, 'PR open', 'Batches submitted as pull requests')}
      {withheld > 0 && stage(withheld, 'packets withheld', 'Held out of PRs for other contributors\' claims: Recheck withheld when they lapse', 'lvl-warn')}
      {setAside > 0 && stage(setAside, 'packets set aside', 'Held out of PRs because they blocked a dry run or upstream already has them: see Needs attention', 'lvl-warn')}
      {failed > 0 && stage(failed, 'failed staging', 'Batches whose re-verification failed: their packets stay passed', 'lvl-error')}
    </div>
  );
}

/**
 * Passed functions → re-verified local branches (one per batch) → one pull request per batch with
 * the repository's own `sr submit`. Submitting is always an explicit click, after a clean dry run.
 */
function BatchesPanel({ runId, status, passed, withheld, setAside, batches, reload }: { runId: string; status: string; passed: number; withheld: number; setAside: number; batches: Batch[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setErr('');
    setMsg('');
    try {
      setMsg(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const stage = () => run('stage', async () => {
    const r = await api.stageRun(runId);
    return `${r.staged} batch(es) staged${r.failed ? `, ${r.failed} failed re-verification (their packets stay passed)` : ''}.`;
  });
  const submit = (b: Batch, real: boolean, allowUncheckedClaims = false) => run(`${real ? 'submit' : 'dry'}-${b.id}`, async () => {
    const r = await api.submitBatch(runId, b.id, real, allowUncheckedClaims);
    if (r.cancelled) return `Dry run of batch ${b.seq} cancelled.`;
    if (real) return r.ok ? `Batch ${b.seq} submitted: ${r.pullRequest ?? r.link ?? 'see the events'}` : `Batch ${b.seq} was not submitted: ${r.error ?? r.blockers.join('; ')}`;
    if (r.ok) return `Dry run of batch ${b.seq} is clean: Submit PR is now available.`;
    if (r.uncheckedClaims?.length && !r.blockers.length && !r.problems.length) return `Dry run of batch ${b.seq}: claims of ${r.uncheckedClaims.length} task(s) could not be checked. Run it again, or explicitly submit the batch unchecked.`;
    return `Dry run of batch ${b.seq} found problems (below).`;
  });
  const cancel = async (b: Batch) => {
    setCancelling(b.id);
    setErr('');
    try {
      await api.cancelBatchDryRun(runId, b.id);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCancelling(null);
    }
  };
  const clear = (b: Batch, scope: 'preview' | 'batch') => run(`clear-${b.id}`, async () => {
    await api.clearBatchBranches(runId, b.id, scope);
    return scope === 'preview' ? `Dry run of batch ${b.seq} cleared.` : `Branch for batch ${b.seq} deleted. Its packets are available to batch again.`;
  });
  const issueRefs = (collisions: Record<string, ClaimCollision[]>) =>
    [...new Set(Object.values(collisions).flat().map((c) => `#${/\/(\d+)$/.exec(c.url)?.[1] ?? c.url}${c.author ? ` ${c.author}` : ''}`))].join(', ');
  const restaged = (r: { failed: number; seqs: number[] } | null) =>
    r?.seqs.length ? ` Restaged as batch ${r.seqs.join(', ')}${r.failed ? ` (${r.failed} failed re-verification; their packets stay passed)` : ''}.` : '';
  const dropCollisions = (b: Batch) => run(`drop-${b.id}`, async () => {
    const r = await api.dropCollisions(runId, b.id);
    if (!r.withheldTasks) return `Batch ${b.seq}: no other open claim or pull request names its functions; nothing changed.`;
    return `Batch ${b.seq}: withheld ${r.withheldFunctions} function(s) in ${r.units.length} unit(s) (claimed in ${issueRefs(r.collisions)}).${r.keptTasks ? restaged(r.staged) : ' No packets were left to restage.'}`;
  });
  const dropAll = () => run('drop-all', async () => {
    const r = await api.dropAllCollisions(runId);
    const hit = r.batches.filter((x) => x.withheldTasks);
    const clear = r.batches.filter((x) => !x.withheldTasks).map((x) => x.seq);
    if (!hit.length) return `Checked ${r.batches.length} batch(es): no other open claim or pull request names their functions; nothing changed.`;
    return `Checked ${r.batches.length} batch(es). Withheld ${r.withheldFunctions} function(s) from batch ${hit.map((x) => `${x.seq} (${x.withheldFunctions})`).join(', ')}; claims by ${issueRefs(r.collisions)}.${restaged(r.staged)}${clear.length ? ` Batch ${clear.join(', ')} ${clear.length === 1 ? 'is' : 'are'} clear.` : ''}`;
  });
  const recheck = () => run('recheck', async () => {
    const r = await api.recheckWithheld(runId);
    return `${r.returnedTasks} withheld packet(s) back into staging, ${r.stillWithheldTasks} still withheld${r.stillWithheldTasks ? ` (${issueRefs(r.collisions)})` : ''}.${restaged(r.staged)}`;
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const droppable = batches.filter((b) => b.status === 'branch_ready' && !b.detail?.pr && !b.detail?.link).length;
  const busyBatch = batches.some((b) => b.dryRunState);
  // The server's slot-holding operation, polled: it survives reloads and clicks from other tabs.
  const [op, setOp] = useState<OperationProgress | null>(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let alive = true;
    let had = false;
    let ticks = 0;
    const poll = async () => {
      const r = await api.operation().catch(() => null);
      if (!alive || !r) return;
      setOp(r.operation);
      const has = !!r.operation;
      ticks++;
      // Reload when an operation ends, and every few seconds while one runs (new batches appear).
      if ((had && !has) || (has && ticks % 4 === 0)) reloadRef.current();
      had = has;
    };
    void poll();
    const t = setInterval(poll, 1_500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const restage = (b: Batch) => run(`restage-${b.id}`, async () => {
    const r = await api.restageBatch(runId, b.id);
    return r.seqs.length ? `Batch ${b.seq}'s packets were re-verified as batch ${r.seqs.join(', ')}${r.failed ? ` (${r.failed} failed re-verification)` : ''}.` : `Batch ${b.seq}: nothing was staged.`;
  });
  const restageFailed = () => run('restage-failed', async () => {
    const r = await api.restageFailed(runId);
    return `Failed batches re-verified: ${r.staged} new batch(es) staged${r.failed ? `, ${r.failed} still failing (in a new failed batch with the current problems)` : ''}.`;
  });
  const describeUnits = (units: Record<string, string[]>) => Object.keys(units).map((u) => u.slice(u.lastIndexOf('/') + 1)).join(', ');
  const setAsideBlocking = (b: Batch) => run(`aside-${b.id}`, async () => {
    const r = await api.setAsideBlocking(runId, b.id);
    return `Batch ${b.seq}: set aside ${r.setAsideFunctions} function(s) in ${Object.keys(r.units).length} unit(s) (${describeUnits(r.units)}).${r.keptTasks ? restaged(r.staged) : ' No packets were left to restage.'}${r.unattributed.length ? ` ${r.unattributed.length} finding(s) name no unit of the batch and stay as they are.` : ''}${r.claims ? ` ${r.claims} claim collision(s): use Drop colliding packets.` : ''}`;
  });
  const setAsideUpstream = () => run('upstream', async () => {
    const r = await api.setAsideUpstream(runId);
    const hit = r.batches.filter((x) => x.setAsideTasks);
    if (!hit.length) return `Checked ${r.batches.length} batch(es) against upstream: none of their functions is matched there and none of their files changed. Nothing to set aside.`;
    return `Checked ${r.batches.length} batch(es) against upstream. Set aside ${r.setAsideFunctions} function(s) from batch ${hit.map((x) => `${x.seq} (${x.setAsideFunctions})`).join(', ')}: upstream already matched them or changed their files.${restaged(r.staged)}${r.clear.length ? ` Batch ${r.clear.join(', ')} ${r.clear.length === 1 ? 'is' : 'are'} clear.` : ''}`;
  });
  const putBack = (units?: string[]) => run('put-back', async () => {
    const r = await api.putBackSetAside(runId, units);
    return `${r.returnedTasks} set-aside packet(s) put back.${restaged(r.staged)}`;
  });
  const [nextLapse, setNextLapse] = useState<number | null>(null);
  useEffect(() => {
    if (!withheld) return setNextLapse(null);
    api.nextWithheldLapse(runId).then((r) => setNextLapse(r.at)).catch(() => undefined);
  }, [runId, withheld, batches]);
  const failedBatches = batches.filter((b) => b.status === 'failed' || b.status === 'interrupted');
  const failedFns = failedBatches.reduce((n, b) => n + b.functions.filter((f) => f.state === 'passed').length, 0);
  const blockedBatches = batches.filter((b) => b.status === 'branch_ready' && !b.detail?.pr && b.detail?.lastSubmit && !b.detail.lastSubmit.ok
    && (b.detail.lastSubmit.problems.length || b.detail.lastSubmit.blockers.some((x) => !/another open claim or pull request/i.test(x))));
  const locked = !!busy || busyBatch || !!op;
  const attention = status === 'completed' && (failedFns > 0 || blockedBatches.length > 0 || withheld > 0 || setAside > 0);
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>PR batches</h2>
        {status === 'completed' && passed > 0 && <button className="primary" disabled={locked} onClick={stage} title="Group passed packets into batches (whole units, up to the run's functions per PR), re-verify each in a clean tree and commit it to a local branch">{busy === 'stage' ? 'Batching…' : `Batch passed functions (${passed} packet${passed === 1 ? '' : 's'})`}</button>}
        {status === 'completed' && droppable > 0 && <ConfirmButton disabled={locked} onConfirm={dropAll} confirmLabel={`Check GitHub claims for all ${droppable} staged batch(es), withhold colliding units and restage the rest?`} title="One claims check for every unsubmitted staged batch: units with a function another contributor's open claim or PR names are withheld, the affected batches' local branches are deleted, and their other packets are re-verified together as new batches. Nothing is pushed.">{busy === 'drop-all' ? 'Checking claims…' : `Drop colliding packets in all batches (${droppable})`}</ConfirmButton>}
        {status === 'completed' && droppable > 0 && <ConfirmButton disabled={locked} onConfirm={setAsideUpstream} confirmLabel={`Check all ${droppable} staged batch(es) against upstream and set aside what it already has or changed?`} title="Reads upstream's data/progress.json and the files each batch writes, at the base (seconds, no compiling): units upstream already matched, no longer tracks, or changed since the batch was built are set aside, and the rest is re-verified. Nothing is pushed.">{busy === 'upstream' ? 'Checking upstream…' : 'Check against upstream'}</ConfirmButton>}
        {status === 'completed' && withheld > 0 && <button disabled={locked} onClick={recheck} title="Check the withheld packets against open claims again and batch every unit that no other contributor's open claim or PR names any more (claims lapse after a day without activity)">{busy === 'recheck' ? 'Checking claims…' : `Recheck withheld (${withheld} packet${withheld === 1 ? '' : 's'})`}</button>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Each batch is re-verified in a clean tree and committed to a local branch. <b>Dry run</b> rebuilds the batch from the base, re-verifies it and runs <span className="mono">sr submit --dry-run</span>; nothing is pushed.
        {' '}<b>Submit PR</b> (after a clean dry run) runs <span className="mono">sr submit</span>: it pushes the batch's branch to your fork and opens one pull request upstream.
        {' '}<b>Drop colliding packets</b> checks GitHub for other contributors' open claims and PRs on the batch's functions, withholds those units and restages the rest as a new batch.
        {' '}A dry run checks upstream first (seconds), recompiles only packets whose last compare no longer proves the tree, and checks every other packet's claims in one GitHub read.
      </p>
      {batches.length > 0 && <BatchPipeline batches={batches} withheld={withheld} setAside={setAside} />}
      {attention && (
        <div className="attention">
          <b>Needs attention</b>
          <ul>
            {failedFns > 0 && (
              <li>
                <span className="lvl-error">{failedBatches.length} failed batch(es)</span>, {failedFns} function(s) waiting to be re-verified.{' '}
                <ConfirmButton className="primary" disabled={locked} onConfirm={restageFailed} confirmLabel={`Re-verify the ${failedFns} functions of ${failedBatches.length} failed batch(es) as new batches?`} title="Re-verifies their passed packets in a clean tree (each unit's sr task is narrowed to the batch's own functions first, so dead sibling packets no longer fail it) and commits new local branches. Nothing is pushed.">{busy === 'restage-failed' ? 'Re-verifying…' : 'Re-verify failed batches'}</ConfirmButton>
              </li>
            )}
            {blockedBatches.map((b) => (
              <li key={b.id}>
                Batch {b.seq}: its last dry run found {(b.detail!.lastSubmit!.blockers.length + b.detail!.lastSubmit!.problems.length)} finding(s) (listed in its row).{' '}
                <ConfirmButton disabled={locked} onConfirm={() => setAsideBlocking(b)} confirmLabel={`Set aside the units batch ${b.seq}'s findings name and re-verify the rest?`} title="Holds the units the findings name out of PRs (a finding on an upstream file is blamed on the unit whose header it includes) and re-verifies the rest as a new batch. Claim collisions are left to Drop colliding packets.">{busy === `aside-${b.id}` ? 'Setting aside…' : 'Set aside blocking units'}</ConfirmButton>
              </li>
            ))}
            {withheld > 0 && (
              <li>
                <span className="lvl-warn">{withheld} packet(s) claimed by others</span>, held out of PRs.{' '}
                {nextLapse ? (nextLapse <= Date.now() ? 'A blocking claim has lapsed: the server rechecks on its own within minutes.' : `The server rechecks on its own when the first claim lapses, in ${fmtDuration(nextLapse - Date.now())} (${new Date(nextLapse).toLocaleString()}).`) : 'The server rechecks on its own when their claims lapse.'}{' '}
                <button disabled={locked} onClick={recheck}>{busy === 'recheck' ? 'Checking claims…' : 'Recheck now'}</button>
              </li>
            )}
            {setAside > 0 && <li><span className="lvl-warn">{setAside} packet(s) set aside</span>: see the list below for why, and Put back when the cause is gone.</li>}
          </ul>
          <SetAsideList batches={batches} locked={locked} busy={busy} putBack={putBack} />
        </div>
      )}
      {msg && <div className="muted" role="status">{msg}</div>}
      {err && <div className="lvl-error">{err}</div>}
      {op ? <OperationPanel op={op} runId={runId} /> : busy ? <div className="op-panel"><div className="op-head"><span className="spinner" aria-hidden="true" /><div className="op-step">Starting…</div></div></div> : null}
      {batches.length > 0 && (
        <table>
          <thead><tr><th>#</th><th>Progress</th><th>Branch</th><th>Functions</th><th>Drafted by</th><th>Findings / PR</th><th /></tr></thead>
          <tbody>
            {batches.map((b) => {
              const d = b.detail;
              const last = d?.lastSubmit;
              // The server holds the prerequisite: a dry run of exactly this batch state.
              const unchecked = d?.dryRunUncheckedClaims ?? [];
              const cleanDry = !!d?.dryRunFingerprint && !unchecked.length;
              const canOverride = !!d?.dryRunFingerprint && unchecked.length > 0;
              const dryRunning = !!b.dryRunState || busy === `dry-${b.id}`;
              const canClear = b.branch?.startsWith('decomp/') && !d?.pr && !d?.link
                && (last?.dryRun !== false || last.submissionStarted === false);
              const findings = last ? [...last.problems.map((x) => `re-verify: ${x}`), ...last.blockers.map((x) => `blocked: ${x}`), ...(last.uncheckedClaims ?? []), ...(last.error && !last.ok ? [last.error] : [])] : [];
              const claimedHere = d?.claimCheck ? Object.keys(d.claimCheck.collisions).length : 0;
              return [
                <tr key={b.id} className={b.status === 'superseded' ? 'superseded' : ''}>
                  <td>{b.seq}</td>
                  <td style={{ minWidth: 280 }}><BatchProgress b={b} /></td>
                  <td className="mono" style={{ fontSize: 11 }}>{b.branch ?? '—'}</td>
                  <td>
                    {b.functions.length || d?.functions || '?'}
                    {b.functions.length > 0 && <div><button style={{ fontSize: 11, padding: '1px 6px', marginTop: 3 }} onClick={() => toggle(b.id)}>{open.has(b.id) ? 'Hide' : 'Show'}{claimedHere ? ` (${claimedHere} claimed)` : ''}</button></div>}
                  </td>
                  <td style={{ fontSize: 12 }}>{d?.draftedBy ?? <span className="muted">—</span>}</td>
                  <td style={{ fontSize: 12, maxWidth: 420 }}>
                    {d?.pr ? <a href={d.pr} target="_blank" rel="noreferrer">{d.pr}</a> : d?.link ? <a href={d.link} target="_blank" rel="noreferrer">open the PR by hand</a> : null}
                    {d?.problems?.length ? <div className="muted">{d.problems.join('; ')}</div> : null}
                    {d?.withheld && <div className="muted">claimed in {issueRefs(d.claimCheck?.collisions ?? {})}: open <b>Show</b> for the functions</div>}
                    {d?.setAside && <div className="muted">set aside: {Object.keys(d.setAside.reasons).map((u) => u.slice(u.lastIndexOf('/') + 1)).join(', ')} ({d.setAside.why})</div>}
                    {last && !d?.pr && (
                      <div className={last.ok ? 'muted' : 'lvl-warn'}>
                        {last.dryRun ? 'dry run' : 'submit'} {new Date(last.at).toLocaleString()}: {last.cancelled ? 'cancelled' : last.ok ? 'clean' : 'problems'}
                        {(last.compared != null || last.durationMs != null) && <span className="muted"> · {last.compared != null ? `${last.compared} recompiled, ${last.reused ?? 0} unchanged` : ''}{last.durationMs != null ? `${last.compared != null ? ', ' : ''}took ${fmtDuration(last.durationMs)}` : ''}</span>}
                        {findings.length > 0 && <ul style={{ margin: '2px 0 0 16px', padding: 0 }}>{findings.slice(0, 8).map((x) => <li key={x}>{x}</li>)}</ul>}
                        {last.warnings.length > 0 && <details><summary>{last.warnings.length} warning(s)</summary><ul style={{ margin: 0, paddingLeft: 16 }}>{last.warnings.map((x) => <li key={x}>{x}</li>)}</ul></details>}
                        {last.plan.length > 0 && <details><summary>plan</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{last.plan.join('\n')}</pre></details>}
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {(b.status === 'interrupted' || b.status === 'failed') && (
                      <ConfirmButton className="primary" disabled={locked} onConfirm={() => restage(b)} confirmLabel={`Re-verify the ${b.functions.length} functions of batch ${b.seq} as a new batch?`} title="Re-verifies exactly this batch's packets in a clean tree and commits a new local branch. Nothing is pushed.">{busy === `restage-${b.id}` ? 'Re-verifying…' : 'Re-verify again'}</ConfirmButton>
                    )}
                    {b.status === 'branch_ready' && (
                      <>
                        {dryRunning ? (
                          <button disabled={b.dryRunState !== 'running' || cancelling === b.id} onClick={() => cancel(b)}>
                            {b.dryRunState === 'cancelling' || cancelling === b.id ? 'Cancelling…' : 'Cancel dry run'}
                          </button>
                        ) : (
                          <>
                            <button disabled={locked} onClick={() => submit(b, false)}>Dry run</button>{' '}
                            {blockedBatches.includes(b) && <><ConfirmButton disabled={locked} onConfirm={() => setAsideBlocking(b)} confirmLabel={`Set aside the units batch ${b.seq}'s findings name and re-verify the rest?`} title="Holds the units the last dry run's findings name out of PRs and re-verifies the rest as a new batch">{busy === `aside-${b.id}` ? 'Setting aside…' : 'Set aside blocking units'}</ConfirmButton>{' '}</>}
                            <ConfirmButton disabled={locked} onConfirm={() => dropCollisions(b)} confirmLabel="Check GitHub claims, withhold colliding units and restage the rest?" title="Withholds every unit with a function that another contributor's open claim or PR names (the rule sr submit blocks on), deletes this batch's local branches and re-verifies the rest as a new batch. Nothing is pushed.">{busy === `drop-${b.id}` ? 'Checking claims…' : 'Drop colliding packets'}</ConfirmButton>{' '}
                            <ConfirmButton className="primary" disabled={locked || !cleanDry} onConfirm={() => submit(b, true)} confirmLabel="Push to your fork and open the PR?" title={cleanDry ? 'Runs sr submit: pushes the branch to your fork and opens one pull request upstream' : 'Run a clean dry run first'}>{busy === `submit-${b.id}` ? 'Submitting…' : 'Submit PR'}</ConfirmButton>
                            {canOverride && (
                              <div style={{ marginTop: 4 }}>
                                <ConfirmButton disabled={locked} onConfirm={() => submit(b, true, true)} confirmLabel={`Claims of ${unchecked.length} task(s) could not be checked against GitHub. Submit anyway?`} title={`Not checked: ${unchecked.join('; ')}. The submission probes again and still refuses any known collision.`}>Submit with unchecked claims</ConfirmButton>
                              </div>
                            )}
                            {canClear && (
                              <div className="row" style={{ marginTop: 4 }}>
                                {(last?.dryRun || cleanDry) && <ConfirmButton disabled={locked} onConfirm={() => clear(b, 'preview')} confirmLabel="Clear check and delete preview branch?">Clear dry run</ConfirmButton>}
                                <ConfirmButton disabled={locked} onConfirm={() => clear(b, 'batch')} confirmLabel="Delete local batch and preview branches?">Delete staged branch</ConfirmButton>
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>,
                open.has(b.id) ? (
                  <tr key={`${b.id}-fns`}>
                    <td />
                    <td colSpan={6}><BatchFunctions b={b} /></td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      )}
      <WithheldList batches={batches} />
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
              <td className="muted" style={{ fontSize: 12 }}>
                {u.map((x) => (
                  <div key={x.model}>
                    <div>{x.model}: {x.attempts} att · ${Number(x.cost_usd ?? 0).toFixed(2)} · cache {Math.round(Number(x.cache_hit_rate ?? 0) * 100)}%</div>
                    <div>
                      {(x.input_tokens ?? 0).toLocaleString()} input · {(x.output_tokens ?? 0).toLocaleString()} output tokens
                      {' · '}{(x.cached_input_tokens ?? 0).toLocaleString()} cached input
                    </div>
                  </div>
                ))}
              </td>
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
/** A run paused on its budget can only continue with a new cap: plain Resume would pause again at once. */
function BudgetPausedBanner({ m, onChange }: { m: Metrics; onChange: () => void }) {
  const spent = m.run.costUsd;
  const [next, setNext] = useState(() => Math.ceil(Math.max(spent * 1.5, (m.run.budgetUsd ?? 0) + 1)));
  const [err, setErr] = useState<string | null>(null);
  const go = (budgetUsd: number | null) => {
    setErr(null);
    api.runAction(m.run.id, 'resume', { budgetUsd }).then(onChange, (e: Error) => setErr(e.message));
  };
  return (
    <div className="lvl-warn" style={{ margin: '8px 0', fontSize: 13 }}>
      Paused: budget reached (${spent.toFixed(2)} spent of ${m.run.budgetUsd}). Resuming needs a higher budget.{' '}
      <label className="inline" style={{ display: 'inline-flex' }}>new budget $<input type="number" min={Math.floor(spent) + 1} step={1} value={next} onChange={(e) => setNext(Number(e.target.value))} style={{ width: 70 }} /></label>{' '}
      <button className="primary" disabled={!(next > spent)} onClick={() => go(next)}>Raise budget &amp; resume</button>{' '}
      <ConfirmButton onConfirm={() => go(null)} confirmLabel="Resume with no budget cap?">Remove cap &amp; resume</ConfirmButton>
      {err && <div className="lvl-error">{err}</div>}
    </div>
  );
}

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
