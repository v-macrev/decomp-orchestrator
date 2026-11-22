// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs: a list of runs, a guided view of one run (progress, what to do next), its PR batches,
// packets and telemetry. Each screen leads with the one next step; details sit one click away.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Flow, Task, TelemetryEvent } from '@decomp/core';
import { api, stream, type AccountView, type Batch, type BatchingStatus, type RunOutage, type CapacityPlan, type ClaimCollision, type OperationProgress, type GatherPreview, type Metrics, type RoutingMetrics, type RunSkillMetrics, type RunSummary, type WorkerQuota } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { TaskDrawer } from '../components/TaskDrawer';

const STATE_COLORS: Record<string, string> = {
  staged: 'var(--ok)', passed: 'var(--ok)', gating: 'var(--info)', leased: 'var(--accent)', pending: 'var(--muted)',
  withheld: 'var(--warn)', set_aside: 'var(--warn)', dead: 'var(--bad)', quarantined: '#e08a4f', cancelled: 'var(--border)',
};

export default function Runs({ mode }: { mode: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(() => api.runs().then((r) => {
    setRuns(r);
    setLoaded(true);
    setSel((s) => s ?? r[0]?.id ?? null);
  }), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);
  const showForm = creating || (loaded && !sel);

  return (
    <div className="page">
      <div className="runs-layout">
        <aside className="stack" style={{ alignContent: 'start' }}>
          <button className={showForm ? 'primary big' : 'big'} onClick={() => setCreating(true)}>+ New run</button>
          <div className="run-list" role="list" aria-label="Runs">
            {runs.map((r) => {
              const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
              const done = (r.counts.staged ?? 0) + (r.counts.passed ?? 0) + (r.counts.dead ?? 0) + (r.counts.quarantined ?? 0) + (r.counts.withheld ?? 0) + (r.counts.set_aside ?? 0);
              return (
                <button key={r.id} role="listitem" className={`run-item${!showForm && r.id === sel ? ' selected' : ''}`} onClick={() => { setSel(r.id); setCreating(false); }}>
                  <span className="name">{r.name}</span>
                  <span className={`chip ${r.status}`}>{r.status}</span>
                  <span className="meta muted small">{done}/{total} done · ${r.costUsd.toFixed(2)}</span>
                  <StackBar counts={r.counts} total={total} />
                </button>
              );
            })}
            {loaded && runs.length === 0 && <p className="muted small">No runs yet. Start one with <b>New run</b>.</p>}
          </div>
        </aside>
        <main className="stack" style={{ minWidth: 0, alignContent: 'start' }}>
          {showForm
            ? <NewRun mode={mode} runs={runs} onCancel={sel ? () => setCreating(false) : undefined} onCreated={(id) => { setSel(id); setCreating(false); refresh(); }} />
            : sel && <RunDetail key={sel} runId={sel} onChange={refresh} onDeleted={() => { setSel(null); refresh(); }} />}
        </main>
      </div>
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

function NewRun({ mode, runs, onCreated, onCancel }: { mode: string; runs: RunSummary[]; onCreated: (id: string) => void; onCancel?: () => void }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [f, setF] = useState({
    name: `run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, flowId: 'default', source: mode === 'sim' ? 'synthetic' : 'sr_next',
    ...flowRunDefaults(undefined), rvas: '', packetMaxFunctions: 4, gateConcurrency: 4, prBatchSize: 40, budgetUsd: '', exposureConsent: true, draftedBy: 'operator',
    routing: true, llmTieBreak: false, workStealing: true, contextMode: 'budgeted',
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
        routing: { enabled: f.routing, llmTieBreak: f.llmTieBreak, workStealing: f.workStealing },
        context: { mode: f.contextMode },
        skills: { enabled: f.skills, autoCurate: f.autoCurate },
      });
      onCreated(r.id);
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const carryBlock = withDead.length > 0 && (
    <div className="panel flat" style={{ display: 'grid', gap: 6, padding: 14 }}>
      <b className="small">Carry failed functions from earlier runs{carried ? ` — ${carried} function(s)` : ''}</b>
      {withDead.map((r) => (
        <label key={r.id} className="inline">
          <input type="checkbox" checked={carryFrom.includes(r.id)} onChange={(e) => setCarryFrom((xs) => (e.target.checked ? [...xs, r.id] : xs.filter((x) => x !== r.id)))} />
          {r.name} <span className="muted">· {r.counts.dead} failed{(r.config.carry as { fromRuns?: string[] } | undefined)?.fromRuns?.length ? ' · itself a carry-over' : ''}</span>
        </label>
      ))}
    </div>
  );
  return (
    <form className="panel stack" onSubmit={submit}>
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>New bulk run</h2>
        {onCancel && <button type="button" className="link" onClick={onCancel}>Back to the run</button>}
      </div>
      <p className="muted" style={{ margin: 0 }}>Choose what to work on and start. The flow preset fills in sensible limits; everything else is under <b>Advanced options</b>.</p>
      <div className="form-grid">
        <label className="wide">Name<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Flow preset<select value={f.flowId} onChange={(e) => selectFlow(e.target.value)}>{flows.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>What to work on
          <select value={f.source} onChange={(e) => set('source', e.target.value)}>
            {mode === 'sim' ? <option value="synthetic">synthetic (simulator)</option> : <><option value="sr_next">next ready functions (sr next)</option><option value="rva_list">a list of RVAs</option></>}
            <option value="gather">scan the inventory with filters</option>
            <option value="carry">only failed functions of earlier runs</option>
          </select>
        </label>
        {!['rva_list', 'carry'].includes(f.source) && <label>How many functions<input type="number" min={1} value={f.count} onChange={(e) => set('count', Number(e.target.value))} /></label>}
        {f.source === 'sr_next' && <label>Max size (bytes)<input type="number" value={f.maxSize} onChange={(e) => set('maxSize', Number(e.target.value))} /></label>}
        <label title="Named on claims, commits and sr submit --drafted-by">Drafted by<input value={f.draftedBy} onChange={(e) => set('draftedBy', e.target.value)} /></label>
      </div>
      {f.source === 'sr_next' && (
        <div className="row">
          <button type="button" onClick={checkAvailability} disabled={checkingAvailability}>{checkingAvailability ? 'Checking upstream…' : 'How many are available?'}</button>
          {availability?.requested === f.count && availability.maxSize === f.maxSize && (
            <span role="status" className={availability.selected < f.count ? 'lvl-warn small' : 'muted small'}>
              {availability.selected} of {availability.requested} are free to take, across {availability.units} source units.
            </span>
          )}
        </div>
      )}
      {f.source === 'rva_list' && <label>RVAs (hex, comma or space separated)<textarea rows={3} value={f.rvas} onChange={(e) => set('rvas', e.target.value)} /></label>}
      {f.source === 'gather' && (
        <div className="panel flat" style={{ display: 'grid', gap: 10, padding: 14 }}>
          <div className="form-grid">
            <label>Max size (bytes)<input type="number" value={f.gMaxSize} onChange={(e) => set('gMaxSize', Number(e.target.value))} /></label>
            <label title="Qualified-name prefixes on :: boundaries">Namespaces / classes<input value={f.gNamespaces} placeholder="RE, BSTArray, TESForm" onChange={(e) => set('gNamespaces', e.target.value)} /></label>
            <label title="reconstruction/<area>/…">Modules<input value={f.gModules} placeholder="skyrim, gamebryo" onChange={(e) => set('gModules', e.target.value)} /></label>
            <label title="Half-open ranges, comma separated">RVA ranges<input value={f.gRange} placeholder="0x1000-0x2000" onChange={(e) => set('gRange', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="inline"><input type="checkbox" checked={f.gExcludeGuess} onChange={(e) => set('gExcludeGuess', e.target.checked)} />Skip GUESS-named functions</label>
            <label className="inline" title="Skip functions whose unit already contains a non-trivial draft"><input type="checkbox" checked={f.gExcludeDrafted} onChange={(e) => set('gExcludeDrafted', e.target.checked)} />Skip drafted</label>
            <span className="grow" />
            <button type="button" disabled={previewing} onClick={() => { setPreviewing(true); api.gatherPreview(gatherFilter()).then(setPreview).catch((e) => setErr(String(e.message))).finally(() => setPreviewing(false)); }}>{previewing ? 'Gathering…' : 'Preview'}</button>
          </div>
          <span className="muted small">Claimed and in-flight functions are always skipped.</span>
          {preview && <GatherSummary g={preview} />}
        </div>
      )}
      {f.source === 'carry' && carryBlock}
      {capacity && capacity.warnings.length > 0 && (
        <div className="notice lvl-warn small">
          {capacity.workers} worker(s) × {capacity.maxPerWorker} = room for {capacity.capacity} of {capacity.batch} functions.
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{capacity.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={f.exposureConsent} onChange={(e) => set('exposureConsent', e.target.checked)} />
        <span>Send private listings (made locally from my own copy of the game) to the configured AI providers. The project requires the owner's explicit agreement; without it workers only see public repository context.</span>
      </label>
      <details className="panel flat" style={{ padding: 14 }}>
        <summary><b>Advanced options</b> <span className="muted small">packets, PR size, budget, staging, routing, skills</span></summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="form-grid">
            <label>Functions per packet<input type="number" min={1} max={60} value={f.packetMaxFunctions} onChange={(e) => set('packetMaxFunctions', Number(e.target.value))} /></label>
            <label>Compares at once<input type="number" min={1} max={64} value={f.gateConcurrency} onChange={(e) => set('gateConcurrency', Number(e.target.value))} /></label>
            <label>Functions per PR (≤60)<input type="number" min={1} max={60} value={f.prBatchSize} onChange={(e) => set('prBatchSize', Number(e.target.value))} /></label>
            <label>Budget (USD)<input value={f.budgetUsd} placeholder="none" onChange={(e) => set('budgetUsd', e.target.value)} /></label>
            <label title="Off: nothing is committed in the target repository and every claim is released at the end">When finished<select value={f.staging} onChange={(e) => set('staging', e.target.value)}><option value="off">commit nothing</option><option value="branches">stage local branches</option></select></label>
            <label title="Hard ceiling of distinct functions one worker instance may take in this run">Max functions per worker<input type="number" min={1} max={5000} value={f.capPerWorker} onChange={(e) => set('capPerWorker', Number(e.target.value))} /></label>
            <label>Context<select value={f.contextMode} onChange={(e) => set('contextMode', e.target.value)}><option value="budgeted">budgeted bundles (v2)</option><option value="legacy">legacy bundles</option></select></label>
          </div>
          {capacity && !capacity.warnings.length && <span className="muted small">{capacity.workers} worker(s) × {capacity.maxPerWorker} = room for {capacity.capacity} of {capacity.batch} functions — ok.</span>}
          <div className="row">
            <label className="inline"><input type="checkbox" checked={f.routing} onChange={(e) => set('routing', e.target.checked)} />Route by complexity</label>
            <label className="inline" title="Idle higher tiers pull lower-tier backlog"><input type="checkbox" checked={f.workStealing} disabled={!f.routing} onChange={(e) => set('workStealing', e.target.checked)} />Work stealing</label>
            <label className="inline" title="Borderline scores go to the Orchestrator's model (shape counts only, never listings)"><input type="checkbox" checked={f.llmTieBreak} disabled={!f.routing} onChange={(e) => set('llmTieBreak', e.target.checked)} />LLM tie-break</label>
            <label className="inline" title="Core skills in the cached prefix + up to 2 triggered skills per attempt (frozen for the run)"><input type="checkbox" checked={f.skills} disabled={f.contextMode !== 'budgeted'} onChange={(e) => set('skills', e.target.checked)} />Skills</label>
            <label className="inline" title="When the run completes: mine, patch, optimize and shadow-evaluate skills automatically"><input type="checkbox" checked={f.autoCurate} disabled={!f.skills || f.contextMode !== 'budgeted'} onChange={(e) => set('autoCurate', e.target.checked)} />Curate after run</label>
          </div>
          {f.source !== 'carry' && carryBlock}
        </div>
      </details>
      {err && <div className="notice error">{err}</div>}
      <div><button className="primary big" type="submit">Start run</button></div>
    </form>
  );
}

/** A soft ring showing how much of the run is done. */
function Ring({ value, label }: { value: number; label: string }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="ring" role="img" aria-label={`${Math.round(v * 100)}% done`}>
      <svg viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--shade)" strokeOpacity=".35" strokeWidth="7" />
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} />
      </svg>
      <div><b>{Math.round(v * 100)}%</b><small>{label}</small></div>
    </div>
  );
}

type RunTab = 'overview' | 'batches' | 'packets' | 'details';

const PAGE_SIZES = [50, 100, 200, 500];
const PACKET_STATES = ['pending', 'leased', 'gating', 'passed', 'staged', 'withheld', 'set_aside', 'dead', 'quarantined', 'cancelled'];
/** The Packets tab's summary: functions (and packets) per group of states; a one-state group filters. */
const PACKET_GROUPS: Array<[string, string[], string]> = [
  ['matched', ['passed', 'staged', 'withheld', 'set_aside'], 'ok'],
  ['in a PR batch', ['staged'], 'ok'],
  ['not batched yet', ['passed'], ''],
  ['held back', ['withheld', 'set_aside'], 'warn'],
  ['to do', ['pending', 'leased', 'gating'], ''],
  ['failed', ['dead', 'quarantined'], 'bad'],
];

const fmtCount = (n: number) => n.toLocaleString();

function Pager({ page, pages, total, pageSize, onPage, onPageSize }: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void; onPageSize: (n: number) => void }) {
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pager" aria-label="Packet pages">
      <span className="muted small grow">{fmtCount(from)}–{fmtCount(to)} of {fmtCount(total)} packets</span>
      <button className="tiny" disabled={page === 0} onClick={() => onPage(0)} aria-label="First page">«</button>
      <button className="tiny" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
      <span className="small">Page {page + 1} of {pages}</span>
      <button className="tiny" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
      <button className="tiny" disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} aria-label="Last page">»</button>
      <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Packets per page">
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} per page</option>)}
      </select>
    </nav>
  );
}

function RunDetail({ runId, onChange, onDeleted }: { runId: string; onChange: () => void; onDeleted: () => void }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [filter, setFilter] = useState('');
  const [task, setTask] = useState<string | null>(null);
  const [tab, setTab] = useState<RunTab | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryFailedError, setRetryFailedError] = useState('');
  const [retryFailedMessage, setRetryFailedMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [batching, setBatching] = useState<BatchingStatus | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('packetsPageSize'));
      return PAGE_SIZES.includes(n) ? n : 100;
    } catch {
      return 100;
    }
  });
  const choosePageSize = (n: number) => {
    setPageSize(n);
    setPage(0);
    try {
      localStorage.setItem('packetsPageSize', String(n));
    } catch {
      /* private window: for this visit only */
    }
  };

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
      api.tasks(runId, filter || undefined, page * pageSize, pageSize).then(setTasks).catch(() => undefined);
      api.batches(runId).then(setBatches).catch(() => undefined);
      api.batching(runId).then(setBatching).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [runId, filter, page, pageSize]);

  if (!m) return <div className="panel muted">Loading the run…</div>;
  const f = m.functions;
  const matched = (f.staged ?? 0) + (f.passed ?? 0) + (f.withheld ?? 0) + (f.set_aside ?? 0);
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
        : 'There are no failed packets to retry.');
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
  const finished = ['completed', 'cancelled', 'failed'].includes(status);
  const selectionShortfall = events.find((event) => event.kind === 'run.selection_shortfall');
  const deadTasks = m.tasks.dead ?? 0;
  const overBudget = m.run.budgetUsd !== null && m.run.costUsd >= m.run.budgetUsd;
  const retryUnavailable = ['cancelled', 'failed', 'created', 'discovering'].includes(status) || overBudget;
  const inFlight = (f.leased ?? 0) + (f.gating ?? 0);
  const left = Math.max(0, m.totalFunctions - done);
  const view: RunTab = tab ?? (status === 'completed' && (batches.length > 0 || (m.tasks.passed ?? 0) > 0) ? 'batches' : 'overview');
  const unbatched = m.tasks.passed ?? 0;
  const live = status === 'running' || status === 'paused';
  const packetTotal = Object.values(m.tasks).reduce((a, b) => a + b, 0);
  const fnTotal = Object.values(f).reduce((a, b) => a + b, 0);
  // The pager counts what the filter shows; a page past the end (packets moved on) goes to the last one.
  const shownTotal = filter ? m.tasks[filter] ?? 0 : packetTotal;
  const pages = Math.max(1, Math.ceil(shownTotal / pageSize));
  if (page >= pages) setPage(pages - 1);
  const sentence = (() => {
    switch (status) {
      case 'running': return `Working on it: ${inFlight} function(s) in progress, ${m.queueDepth} waiting${m.throughput.etaMinutes !== null ? `, about ${m.throughput.etaMinutes} min left` : ''}.`;
      case 'paused': return overBudget ? 'Paused: the budget is used up. Raise it to continue.' : m.run.outage ? 'Paused: no AI account can work right now. It resumes on its own as soon as one is back.' : 'Paused. Resume to carry on where it stopped.';
      case 'created': case 'discovering': return 'Getting the functions ready…';
      case 'completed': return `Finished: ${matched} matched, ${f.dead ?? 0} failed.${unbatched || batches.length ? ' Next: the PR batches tab.' : ''}`;
      case 'cancelled': return 'Cancelled. Matched functions are kept.';
      default: return `The run ${status}.`;
    }
  })();
  const tabs: Array<[RunTab, string, ReactNode?]> = [
    ['overview', 'Overview'],
    ['batches', 'PR batches', batches.filter((b) => b.status === 'branch_ready').length || null],
    ['packets', 'Packets', m.totalFunctions ? `${fmtCount(packetTotal)} · ${fmtCount(fnTotal)} fn` : null],
    ['details', 'Telemetry'],
  ];
  return (
    <>
      <div className="panel stack">
        <div className="run-head">
          <Ring value={done / Math.max(1, m.totalFunctions)} label={`${done}/${m.totalFunctions}`} />
          <div className="stack" style={{ gap: 10, minWidth: 0 }}>
            <div className="row">
              <h2 className="grow" style={{ margin: 0 }}>{m.run.name} <span className={`chip ${status}`}>{status}</span></h2>
              {status === 'running' && <button onClick={() => act('pause')}>Pause</button>}
              {status === 'paused' && <button className="primary" onClick={() => act('resume')} disabled={overBudget} title={overBudget ? 'Budget reached: set a new budget under More → Edit to resume' : undefined}>Resume</button>}
              {deadTasks > 0 && !retryUnavailable && (
                <ConfirmButton onConfirm={retryFailed} disabled={retryingFailed} className={status === 'completed' ? '' : 'primary'} confirmLabel={`Retry ${deadTasks} failed packet(s)?`} title="Retries only failed packets, starting at the fast tier; matched and quarantined ones are left alone. Uses this run's remaining budget.">{retryingFailed ? 'Retrying…' : `Retry ${deadTasks} failed`}</ConfirmButton>
              )}
              <details className="menu">
                <summary>More</summary>
                <div className="menu-list">
                  <button onClick={() => setEditing((x) => !x)}>{editing ? 'Close edit' : 'Edit run…'}</button>
                  {status === 'running' && <button onClick={() => act('pause', { immediate: true })} title="Abort in-flight attempts (not counted against tasks)">Pause now</button>}
                  {!finished && <ConfirmButton className="" onConfirm={applyFlow} confirmLabel="Apply the preset's models and limits?" title="Re-reads this run's flow template: models, capability, attempts and checks change from the next attempt on.">Apply flow changes</ConfirmButton>}
                  {!finished && <ConfirmButton onConfirm={() => act('cancel')} confirmLabel="Cancel the run? Open tasks stop">Cancel run</ConfirmButton>}
                  <ConfirmButton onConfirm={removeRun} disabled={m.engine.active || ['running', 'discovering'].includes(status)} confirmLabel="Delete the run and its history?" title={m.engine.active ? 'Cancel or finish the run first' : 'Deletes the run, its packets, attempts and events; local claims it still holds are released (not those in a submitted PR)'}>Delete run</ConfirmButton>
                </div>
              </details>
            </div>
            <div className="muted">{sentence}</div>
            <div className="tiles">
              <div className="tile ok"><b>{matched}</b><span>matched</span></div>
              <div className={`tile ${f.dead ? 'bad' : ''}`}><b>{f.dead ?? 0}</b><span>failed{f.quarantined ? ` · ${f.quarantined} quarantined` : ''}</span></div>
              <div className="tile"><b>{finished ? '—' : left}</b><span>{finished ? 'nothing left to do' : 'still to do'}</span></div>
              <div className="tile"><b>${m.usage.costUsd.toFixed(2)}</b><span>spent{m.run.budgetUsd ? ` of $${m.run.budgetUsd}` : ''}</span></div>
            </div>
          </div>
        </div>
        {editing && <RunEditor runId={runId} status={status} onSaved={() => { setEditing(false); onChange(); api.metrics(runId).then(setM).catch(() => undefined); }} />}
        {retryFailedError && <div className="notice error">{retryFailedError}</div>}
        {retryFailedMessage && <div className="notice" role="status">{retryFailedMessage}</div>}
        {m.run.error && <div className="notice error">{m.run.error}</div>}
        {selectionShortfall && <div className="notice lvl-warn" role="status">{selectionShortfall.msg}</div>}
        {status === 'paused' && overBudget && <BudgetPausedBanner m={m} onChange={onChange} />}
        {status === 'paused' && m.run.outage && <OutageBanner o={m.run.outage} />}
      </div>

      <div><nav className="segmented" aria-label="Run sections">
        {tabs.map(([k, l, n]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setTab(k)} aria-current={view === k ? 'page' : undefined}>{l}{n ? <span className="count">{n}</span> : null}</button>)}
      </nav></div>

      {view === 'overview' && (
        <>
          <div className="panel stack">
            <StackBar counts={f} total={m.totalFunctions} />
            <div className="kpis">
              <Kpi l="Functions done" v={`${done}/${m.totalFunctions}`} />
              <Kpi l="Matched" v={matched} c="var(--ok)" />
              <Kpi l="Waiting" v={m.queueDepth} />
              <Kpi l="In progress" v={inFlight} />
              <Kpi l="Busy slots" v={`${m.engine.busySlots}/${m.engine.activeSlots}`} />
              <Kpi l="Failed" v={f.dead ?? 0} c="var(--bad)" />
              <Kpi l="Quarantined" v={f.quarantined ?? 0} c="var(--warn)" />
              <Kpi l="Retries" v={m.routes.retry ?? 0} />
              <Kpi l="Escalations" v={m.routes.escalate ?? 0} />
              <Kpi l="Matched / min" v={m.throughput.passedPerMin5} />
              <Kpi l="ETA" v={m.throughput.etaMinutes === null ? '—' : `${m.throughput.etaMinutes} min`} />
              <Kpi l="Tokens in / out" v={`${fmt(m.usage.inputTokens)} / ${fmt(m.usage.outputTokens)}`} />
              <Kpi l="Provider errors" v={m.usage.providerErrors} />
            </div>
            <Sparkline series={m.throughput.series} />
          </div>
          <div className="panel">
            <h2>What happened</h2>
            <div className="log">{events.slice().reverse().map((e) => <div key={`${e.seq}-${e.ts}`} className={`lvl-${e.level}`}>{new Date(e.ts).toLocaleTimeString()} <b>{e.kind}</b> {e.msg}</div>)}</div>
          </div>
        </>
      )}

      {view === 'batches' && (
        batches.length > 0 || (status === 'completed' && unbatched > 0) || live
          ? <BatchesPanel runId={runId} status={status} passed={unbatched} withheld={m.tasks.withheld ?? 0} setAside={m.tasks.set_aside ?? 0} heldFunctions={(f.withheld ?? 0) + (f.set_aside ?? 0)} batching={batching} batches={batches} reload={() => {
            api.batches(runId).then(setBatches).catch(() => undefined);
            api.batching(runId).then(setBatching).catch(() => undefined);
          }} />
          : <div className="hero"><span className="eyebrow">PR batches</span><h3>{finished ? 'Nothing to batch' : 'Batches come when the run finishes'}</h3><p>{finished ? 'This run has no matched functions waiting for a pull request.' : 'Matched functions are grouped into pull requests once the run has finished.'}</p></div>
      )}

      {view === 'packets' && (
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 className="grow" style={{ margin: 0 }}>Packets</h2>
            <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} aria-label="Filter by state">
              <option value="">all states ({fmtCount(packetTotal)} packets · {fmtCount(fnTotal)} functions)</option>
              {PACKET_STATES.map((s) => <option key={s} value={s}>{s} ({fmtCount(m.tasks[s] ?? 0)} packets · {fmtCount(f[s] ?? 0)} functions)</option>)}
            </select>
          </div>
          <div className="pkt-sum" aria-label="Functions by state">
            {PACKET_GROUPS.map(([label, states, tone]) => {
              const fns = states.reduce((n, s) => n + (f[s] ?? 0), 0);
              const pk = states.reduce((n, s) => n + (m.tasks[s] ?? 0), 0);
              const body = <><b>{fmtCount(fns)}</b><span>{label}</span><span className="muted small">{fmtCount(pk)} packet{pk === 1 ? '' : 's'}</span></>;
              const title = `${fmtCount(fns)} function(s) in ${fmtCount(pk)} packet(s)`;
              if (states.length > 1) return <div key={label} className={`pkt-stat ${tone}`} title={`${title}: ${states.join(', ')}`}>{body}</div>;
              const on = filter === states[0];
              return (
                <button key={label} className={`pkt-stat ${tone} ${on ? 'active' : ''}`} disabled={!pk && !on} aria-pressed={on} onClick={() => { setFilter(on ? '' : states[0]!); setPage(0); }} title={`${title}; click to ${on ? 'show every state' : 'show only these'}`}>
                  {body}
                </button>
              );
            })}
          </div>
          <Pager page={page} pages={pages} total={shownTotal} pageSize={pageSize} onPage={setPage} onPageSize={choosePageSize} />
          <div style={{ overflowX: 'auto' }}>
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
                {tasks.length === 0 && <tr><td colSpan={8} className="muted">No packets in this state.</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && <Pager page={page} pages={pages} total={shownTotal} pageSize={pageSize} onPage={setPage} onPageSize={choosePageSize} />}
        </div>
      )}

      {view === 'details' && (
        <>
          <TokenPanel m={m} />
          {m.routing && <RoutingPanel r={m.routing} knowledge={m.knowledge} />}
          {m.skills?.enabled && <RunSkillsPanel s={m.skills} />}
          {m.workers?.list.length > 0 && <WorkerQuotaPanel m={m} onChange={onChange} />}
          {m.gather && <div className="panel"><h2>Function gathering</h2><GatherSummary g={m.gather} /></div>}
          <div className="panel">
            <h2>Account pool</h2>
            <div style={{ overflowX: 'auto' }}><AccountsTable accounts={m.accounts} usage={m.byAccount} /></div>
          </div>
        </>
      )}
      {task && <TaskDrawer taskId={task} onClose={() => setTask(null)} />}
    </>
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

type Tone = 'ok' | 'warn' | 'bad' | 'next' | 'muted';
type BatchAction = 'submit' | 'dry' | 'drop' | 'aside' | 'restage' | 'update' | 'none';
const isClaimBlocker = (x: string) => /another open claim or pull request/i.test(x);
/** Other people's comments on the batch's pull request (the ones a fix or an explanation is about). */
const reviewOf = (b: Batch) => (b.detail?.prStatus?.comments ?? []).filter((c) => !c.mine && c.body.trim());
/** A comment's words without GitHub's hidden HTML markers. */
const commentText = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const prRef = (b: Batch) => (b.detail?.updatesPr?.pr ? issueNo(b.detail.updatesPr.pr) : 'the PR');
const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/**
 * A batch in plain words: where it is on checked → claims → dry run → PR, what that means, and the
 * one thing to do next.
 */
function batchView(b: Batch): { tone: Tone; title: string; why: string; action: BatchAction; steps: Array<{ label: string; state: StepState; title: string }> } {
  const d = b.detail;
  const last = d?.lastSubmit;
  const collisions = d?.claimCheck ? Object.keys(d.claimCheck.collisions).length : null;
  const claimBlockers = last?.blockers.filter(isClaimBlocker).length ?? 0;
  const otherFindings = (last?.blockers.length ?? 0) - claimBlockers + (last?.problems.length ?? 0);
  const unchecked = d?.dryRunUncheckedClaims ?? [];
  const cleanDry = !!d?.dryRunFingerprint && !unchecked.length;
  const claimed = collisions ? collisions : collisions === null ? claimBlockers : 0;
  const dryFailed = !!last?.dryRun && !last.cancelled && !last.ok && !cleanDry;
  const steps: Array<{ label: string; state: StepState; title: string }> = [
    b.status === 'failed' || b.status === 'interrupted'
      ? { label: 'Check failed', state: 'blocked', title: 'Re-verification in a clean tree did not pass: nothing was committed' }
      : b.status === 'draft'
        ? { label: 'Checking…', state: 'next', title: 'Being re-verified in a clean tree now' }
        : { label: 'Checked', state: 'done', title: 'Re-verified in a clean tree and committed to a local branch' },
    claimed
      ? { label: `${claimed} claimed`, state: 'blocked', title: 'Other contributors have open claims or PRs on some functions' }
      : collisions === 0 || cleanDry
        ? { label: 'Claims clear', state: 'done', title: 'No other open claim or PR names these functions' }
        : { label: 'Claims', state: 'todo', title: 'Not checked yet: a dry run checks them' },
    cleanDry
      ? { label: 'Dry run clean', state: 'done', title: 'sr submit --dry-run passed for exactly this batch' }
      : dryFailed
        ? { label: 'Dry run failed', state: 'blocked', title: 'The last dry run found problems' }
        : { label: 'Dry run', state: 'todo', title: 'Needed before Submit PR' },
    b.status === 'submitted'
      ? d?.prStatus?.state === 'merged'
        ? { label: 'Merged', state: 'done', title: `Merged upstream ${shortDate(d.prStatus.mergedAt)}` }
        : d?.prStatus?.state === 'closed'
          ? { label: 'Closed', state: 'blocked', title: `Closed without merging ${shortDate(d.prStatus.closedAt)}` }
          : reviewOf(b).length
            ? { label: `PR · ${reviewOf(b).length} comment${reviewOf(b).length === 1 ? '' : 's'}`, state: 'next', title: 'Open, with review comments' }
            : { label: 'PR open', state: 'done', title: d?.pr ?? '' }
      : { label: 'PR', state: 'todo', title: 'Available after a clean dry run' },
  ];
  const next = (i: number) => {
    if (steps[i]!.state === 'todo') steps[i]!.state = 'next';
  };
  if (b.status === 'submitted') {
    const st = d?.prStatus;
    const n = reviewOf(b).length;
    const said = `${n} comment${n === 1 ? '' : 's'} from others`;
    if (d?.prUpdateOf !== undefined) return { tone: 'ok', title: 'Fixes pushed to the PR', why: `Pushed to batch ${d.prUpdateOf}'s pull request as one more commit${d.commit ? ` (${d.commit.slice(0, 10)})` : ''}.`, action: 'none', steps };
    if (d?.reviewFix) return { tone: 'next', title: 'Being fixed from the review', why: `${d.reviewFix.taskIds.length} packet(s) are with the AI agents, with the ${d.reviewFix.comments} review comment(s) as instructions. When the run finishes, push the fixes to this pull request from the new batch's card.`, action: 'none', steps };
    if (st?.state === 'merged') return { tone: 'ok', title: 'Merged upstream', why: `Merged ${shortDate(st.mergedAt)}. Nothing more to do${n ? `; ${said} are below` : ''}.`, action: 'none', steps };
    if (st?.state === 'closed') return { tone: 'bad', title: 'Closed without merging', why: n ? `Closed ${shortDate(st.closedAt)} with ${said}. Read them in plain words, or let the AI agents fix the code from them: the result becomes a new pull request.` : `Closed ${shortDate(st.closedAt)}, and nobody else commented. Open it on GitHub to see why.`, action: 'none', steps };
    if (st?.state === 'open' && n) return { tone: 'warn', title: 'Reviewers commented', why: `${said} on the open pull request. Read them in plain words, or let the AI agents fix the code from them: the fixes go to the same pull request.`, action: 'none', steps };
    return { tone: 'ok', title: 'Pull request open', why: d?.pr ? (st ? 'Waiting for review on GitHub. The comments show up here.' : 'Submitted upstream. Its state on GitHub shows up here.') : 'Submitted: open the pull request by hand from the link below.', action: 'none', steps };
  }
  if (b.status === 'branch_ready' && d?.updatesPr) return { tone: 'ok', title: 'Fixes ready for the PR', why: `Fixed from batch ${d.updatesPr.seq}'s review and checked in a clean tree. Push them to the same pull request as one more commit (every packet of the PR is checked again first).`, action: 'update', steps };
  if (b.status === 'draft') return { tone: 'next', title: 'Being checked now', why: 'Re-verifying it in a clean tree; see the progress at the top.', action: 'none', steps };
  if (b.status === 'interrupted') return { tone: 'bad', title: 'Interrupted by a restart', why: 'A server restart stopped its check. Nothing was committed and nothing is lost: check it again.', action: 'restage', steps };
  if (b.status === 'failed') return { tone: 'bad', title: 'Its check failed', why: 'Some packets did not match in a clean tree. Check again (a restart or a flaky compile clears on its own), or let the AI agents fix the packets that fail.', action: 'restage', steps };
  if (b.status === 'superseded') {
    const held = [
      d?.withheld ? `${d.withheld.taskIds.length} packet(s) held back for claims` : '',
      d?.setAside ? `${d.setAside.taskIds.length} packet(s) set aside (${d.setAside.why})` : '',
      d?.rebalanced ? `combined with other batches into bigger ones (at most ${d.rebalanced.max} functions)` : '',
      d?.reviewFix ? `its pull request was closed; ${d.reviewFix.taskIds.length} packet(s) went to the AI agents with ${d.reviewFix.comments} review comment(s) and the rest is batched again, for a new pull request` : '',
      d?.fixed ? `${d.fixed.functions} function(s) in ${d.fixed.taskIds.length} packet(s) sent back to the AI agents to fix its ${d.fixed.check === 're-verify' ? 'check' : 'dry run'}; the rest is batched again when the run finishes` : '',
    ].filter(Boolean).join(', ');
    return { tone: 'muted', title: 'Replaced', why: `${held || 'Its packets were checked again'}${d?.supersededBy?.length ? `; the rest moved to batch ${d.supersededBy.join(', ')}` : ''}.`, action: 'none', steps };
  }
  if (claimed) return { tone: 'bad', title: 'Someone else claimed part of it', why: `Other contributors have open claims or PRs on ${claimed} function(s), so sr submit refuses it. Hold those units back; the rest becomes a new batch.`, action: 'drop', steps };
  const outside = b.outside ?? [];
  if (dryFailed && otherFindings && outside.length >= otherFindings) {
    const files = [...new Set(outside.map((x) => x.slice(0, x.search(/:\d+:/))))];
    return {
      tone: 'bad', title: 'Blocked by a file this batch does not write',
      why: `The dry run blames ${files.map((f) => f.slice(f.lastIndexOf('/') + 1)).join(', ')}, an upstream file that includes a header this batch changes; the line is wrong upstream. The AI agents cannot fix it (it is not in their packets). Set aside the units that change that header; the rest becomes a new batch, and they come back once upstream fixes the file.`,
      action: 'aside', steps,
    };
  }
  if (dryFailed && otherFindings) return { tone: 'bad', title: 'The dry run found problems', why: `${otherFindings} finding(s), listed under Details. Set aside the units they name; the rest becomes a new batch.`, action: 'aside', steps };
  if (dryFailed) return { tone: 'bad', title: 'The dry run did not pass', why: last?.error ?? 'See the details, then run it again.', action: 'dry', steps };
  if (unchecked.length) {
    next(1);
    return { tone: 'warn', title: 'Claims could not be checked', why: 'GitHub could not be reached for part of the batch. Run the dry run again.', action: 'dry', steps };
  }
  if (!cleanDry) {
    next(2);
    return { tone: 'next', title: 'Needs a dry run', why: 'A dry run rebuilds it from upstream and runs every check sr submit does. Nothing is pushed.', action: 'dry', steps };
  }
  next(3);
  return { tone: 'ok', title: 'Ready to submit', why: 'The dry run is clean. Submitting pushes the branch to your fork and opens one pull request.', action: 'submit', steps };
}

function StepDots({ steps }: { steps: Array<{ label: string; state: StepState; title: string }> }) {
  return (
    <div className="stepdots" aria-label="Progress">
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'contents' }}>
          {i > 0 && <span className="line" aria-hidden="true" />}
          <span className={`s ${s.state}`} title={s.title}>{s.state === 'done' ? '✓' : s.state === 'blocked' ? '✕' : s.state === 'next' ? '→' : '○'} {s.label}</span>
        </span>
      ))}
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
          {op.label !== op.step && <div className="op-phase">{other ? 'Another run' : op.label}</div>}
          <div className="op-step">{op.step}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {other ? `Another run holds the worktree slots: ${op.label}. ` : ''}
            running for {fmtDuration(now - op.startedAt)}{op.step !== op.label ? ` · this step ${fmtDuration(now - op.stepStartedAt)}` : ''}
            {op.total ? ` · ${op.done ?? 0} of ${op.total} done` : ''}
          </div>
        </div>
      </div>
      {op.detail && <div className="op-detail">{op.detail}</div>}
      {pct !== null && <div className="bar"><span style={{ width: `${pct}%` }} /></div>}
      {op.log.length > 0 && (
        <ol start={Math.max(1, op.log.length - 5)}>
          {op.log.slice(-6).map((l) => <li key={`${l.at}-${l.step}`}>✓ {l.step} <span>({fmtDuration(l.ms)})</span></li>)}
        </ol>
      )}
      <div className="muted" style={{ fontSize: 11 }}>Runs on the server: you can leave or reload this page. Buttons wait until it finishes.</div>
    </div>
  );
}

type HeldReason = 'merged' | 'untracked' | 'changed' | 'dryrun' | 'claimed' | 'fixing';
const HELD_LABEL: Record<HeldReason, string> = {
  merged: 'Already merged upstream',
  untracked: 'No longer tracked upstream',
  changed: 'Upstream changed the file',
  dryrun: 'Blocked a dry run',
  claimed: 'Claimed by someone else',
  fixing: 'Being fixed by AI agents',
};
const HELD_HINT: Record<HeldReason, string> = {
  merged: 'Upstream data/progress.json already records these functions as matched: nothing to submit for them.',
  untracked: 'Upstream data/progress.json no longer lists these functions.',
  changed: 'Upstream changed a file these units write since they were batched: submitting would overwrite their version.',
  dryrun: 'sr submit --dry-run blamed their unit (lint, origin statements, a failed compare…).',
  claimed: "Another contributor's open claim or PR names a function in their unit.",
  fixing: 'Sent back to the AI agents from a failed check: they come back to a batch when the run finishes.',
};

/** Why each held-back function is out of the PRs, from the set-aside findings, the withheld claims and the agents' fixes. */
function heldBackReasons(batches: Batch[]) {
  const byFn = new Map<string, { reason: HeldReason; rva: string; name: string | null; unit: string; detail: string }>();
  const latest = [...batches].sort((x, y) => y.seq - x.seq);
  for (const b of latest) {
    const sa = b.detail?.setAside;
    for (const f of b.functions) {
      const key = `${f.taskId}:${f.rva}`;
      if (byFn.has(key)) continue;
      if (f.state === 'withheld') {
        const claims = b.detail?.claimCheck?.collisions[f.rva] ?? [];
        byFn.set(key, { reason: 'claimed', rva: f.rva, name: f.name, unit: f.unit, detail: claims.map((c) => issueNo(c.url)).join(', ') || 'held back with its unit' });
      } else if (f.state === 'set_aside' && sa?.units.includes(f.unit)) {
        const reasons = sa.reasons[f.unit] ?? [];
        const names = (re: RegExp) => reasons.find((r) => re.test(r) && r.toLowerCase().includes(f.rva.toLowerCase()));
        const merged = names(/already matched upstream/i);
        const untracked = names(/no longer tracked upstream/i);
        const changed = reasons.find((r) => /upstream changed this file/i.test(r));
        const reason: HeldReason = merged ? 'merged' : untracked ? 'untracked' : changed ? 'changed' : 'dryrun';
        byFn.set(key, { reason, rva: f.rva, name: f.name, unit: f.unit, detail: merged ?? untracked ?? changed ?? reasons[0] ?? sa.why });
      } else if (['pending', 'leased', 'gating'].includes(f.state) && (b.detail?.fixed?.taskIds.includes(f.taskId) || b.detail?.reviewFix?.taskIds.includes(f.taskId))) {
        byFn.set(key, { reason: 'fixing', rva: f.rva, name: f.name, unit: f.unit, detail: `from batch ${b.seq}` });
      }
    }
  }
  const counts = Object.fromEntries((Object.keys(HELD_LABEL) as HeldReason[]).map((k) => [k, 0])) as Record<HeldReason, number>;
  for (const v of byFn.values()) counts[v.reason]++;
  return { counts, rows: [...byFn.values()] };
}

/** KPIs: why matched functions are not in a pull request yet, each with the functions behind it. */
function HeldBackKpis({ batches }: { batches: Batch[] }) {
  const { counts, rows } = heldBackReasons(batches);
  const [show, setShow] = useState<HeldReason | null>(null);
  if (!rows.length) return null;
  const tone: Record<HeldReason, string | undefined> = { merged: 'var(--ok)', untracked: undefined, changed: 'var(--warn)', dryrun: 'var(--bad)', claimed: 'var(--warn)', fixing: undefined };
  const list = show ? rows.filter((r) => r.reason === show) : [];
  return (
    <div className="panel stack" style={{ gap: 8 }}>
      <div><h2 style={{ marginBottom: 4 }}>Why functions are held back</h2><span className="muted small">{rows.length} matched function(s) are not in a pull request yet. Click a number to see them.</span></div>
      <div className="kpis">
        {(Object.keys(HELD_LABEL) as HeldReason[]).map((k) => (
          <button key={k} type="button" className={`kpi kpi-btn${show === k ? ' on' : ''}`} title={HELD_HINT[k]} disabled={!counts[k]} onClick={() => setShow(show === k ? null : k)} aria-pressed={show === k}>
            <div className="v" style={counts[k] && tone[k] ? { color: tone[k] } : undefined}>{counts[k]}</div>
            <div className="l">{HELD_LABEL[k]}</div>
          </button>
        ))}
      </div>
      {show && (
        <div style={{ overflowX: 'auto' }}>
          <p className="muted small" style={{ margin: '2px 0 6px' }}>{HELD_HINT[show]}</p>
          <table className="fns">
            <thead><tr><th>Function</th><th>Unit</th><th>Reason</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={`${r.unit}-${r.rva}`}>
                  <td><span className="mono">{r.rva}</span> {r.name ?? ''}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.unit.slice(r.unit.lastIndexOf('/') + 1)}</td>
                  <td style={{ fontSize: 12 }}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    <details style={{ marginTop: 8 }}>
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

/**
 * Passed functions → re-verified local branches (one per batch) → one pull request per batch with
 * the repository's own `sr submit`. The screen leads with the one next step (usually "Prepare all
 * for PR", which runs every fix-up and dry run in order); submitting stays an explicit click per batch.
 */
/** While the run goes on: how full the next PR batch is (whole units only), and what still waits on its unit. */
function RollingMeter({ b, status, locked, busy, onBatchNow }: { b: BatchingStatus; status: string; locked: boolean; busy: boolean; onBatchNow: () => void }) {
  const n = b.fresh.functions;
  const pct = Math.min(100, (n / Math.max(1, b.batchSize)) * 100);
  const full = n >= b.batchSize;
  const ready = b.ready.functions;
  return (
    <div className={`rolling ${full ? 'full' : ''}`} aria-label="Next PR batch">
      <div className="row">
        <span className="eyebrow grow">{b.rolling ? 'Next PR batch' : 'Ready to batch'}</span>
        {b.batching && <span className="small"><span className="spinner" aria-hidden="true" /> making a batch now…</span>}
        {/* Only the operator makes a batch under the minimum: never done on its own. */}
        {ready > 0 && !b.batching && (
          <ConfirmButton className="" disabled={locked} onConfirm={onBatchNow}
            confirmLabel={`Make a batch of ${ready} function${ready === 1 ? '' : 's'}?${ready < b.fullAt ? ` (under the ${b.fullAt} minimum)` : ''}`}
            title={`Batches the ${ready} ready function${ready === 1 ? '' : 's'} (${b.ready.units} finished unit${b.ready.units === 1 ? '' : 's'}) now, even under the ${b.fullAt}-function minimum, and checks the batch in a clean tree beside the workers. Units still being worked on are left out. Nothing is pushed.`}>
            {busy ? 'Batching…' : `Batch ${ready === 1 ? 'it' : `these ${ready}`} now`}
          </ConfirmButton>
        )}
      </div>
      <div className="row">
        <span className="big-n">{fmtCount(n)} of {b.batchSize}</span>
        <span className="muted grow">functions ready{b.fresh.units ? ` in ${b.fresh.units} finished unit${b.fresh.units === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={b.batchSize} aria-valuenow={Math.min(n, b.batchSize)}>
        <div className="track"><div className="fill" style={{ width: `${pct}%` }} /><div className="mark" style={{ left: `${(b.fullAt / Math.max(1, b.batchSize)) * 100}%` }} title={`a batch can be made from ${b.fullAt} functions`} /></div>
      </div>
      <span className="muted small">
        {b.rolling
          ? `Once ${b.batchSize} functions of finished units are ready, they become a batch at once (checked in a clean tree beside the workers), so you can dry-run and submit it while the run goes on.`
          : status === 'paused' ? 'The run is paused: Prepare all for PR batches the ready functions.' : 'Staging is off for this run: Prepare all for PR batches the ready functions.'}
        {b.waiting.functions > 0 && ` ${fmtCount(b.waiting.functions)} more matched function${b.waiting.functions === 1 ? ' waits' : 's wait'} for packets still in progress in ${b.waiting.units === 1 ? 'its unit' : `their ${b.waiting.units} units`}.`}
        {b.ready.functions > b.fresh.functions && ` ${fmtCount(b.ready.functions - b.fresh.functions)} are in a failed batch: Prepare all checks them again.`}
      </span>
    </div>
  );
}

function BatchesPanel({ runId, status, passed, withheld, setAside, heldFunctions, batching, batches, reload }: { runId: string; status: string; passed: number; withheld: number; setAside: number; heldFunctions: number; batching: BatchingStatus | null; batches: Batch[]; reload: () => void }) {
  const completed = status === 'completed';
  // PR steps work on a finished run, and beside a running or paused one (on the staging worktree).
  const live = status === 'running' || status === 'paused';
  const pipeline = completed || live;
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
    return `${r.staged} batch(es) made${r.failed ? `, ${r.failed} did not pass their check (their packets are kept)` : ''}.`;
  });
  const prepare = () => run('prepare', async () => {
    await api.prepareAll(runId);
    return 'Preparing the batches: follow the steps above. It runs on the server, so you can leave this page.';
  });
  const submit = (b: Batch, real: boolean, allowUncheckedClaims = false) => run(`${real ? 'submit' : 'dry'}-${b.id}`, async () => {
    const r = await api.submitBatch(runId, b.id, real, allowUncheckedClaims);
    if (r.cancelled) return `Dry run of batch ${b.seq} cancelled.`;
    if (real) return r.ok ? `Batch ${b.seq} submitted: ${r.pullRequest ?? r.link ?? 'see the events'}` : `Batch ${b.seq} was not submitted: ${r.error ?? r.blockers.join('; ')}`;
    if (r.ok) return `Dry run of batch ${b.seq} is clean: it is ready to submit.`;
    if (r.uncheckedClaims?.length && !r.blockers.length && !r.problems.length) return `Dry run of batch ${b.seq}: claims of ${r.uncheckedClaims.length} task(s) could not be checked. Run it again, or submit it unchecked under Details.`;
    return `Dry run of batch ${b.seq} found problems: see its card.`;
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
    return scope === 'preview' ? `Dry run of batch ${b.seq} cleared.` : `Branch for batch ${b.seq} deleted. Its packets can be batched again.`;
  });
  const issueRefs = (collisions: Record<string, ClaimCollision[]>) =>
    [...new Set(Object.values(collisions).flat().map((c) => `#${/\/(\d+)$/.exec(c.url)?.[1] ?? c.url}${c.author ? ` ${c.author}` : ''}`))].join(', ');
  const restaged = (r: { failed: number; seqs: number[] } | null) =>
    r?.seqs.length ? ` The rest is now batch ${r.seqs.join(', ')}${r.failed ? ` (${r.failed} did not pass their check)` : ''}.` : '';
  const dropCollisions = (b: Batch) => run(`drop-${b.id}`, async () => {
    const r = await api.dropCollisions(runId, b.id);
    if (!r.withheldTasks) return `Batch ${b.seq}: nobody else claims its functions now; nothing changed.`;
    return `Batch ${b.seq}: held back ${r.withheldFunctions} function(s) in ${r.units.length} unit(s) (claimed in ${issueRefs(r.collisions)}).${r.keptTasks ? restaged(r.staged) : ''}`;
  });
  const dropAll = () => run('drop-all', async () => {
    const r = await api.dropAllCollisions(runId);
    const hit = r.batches.filter((x) => x.withheldTasks);
    if (!hit.length) return `Checked ${r.batches.length} batch(es): nobody else claims their functions.`;
    return `Held back ${r.withheldFunctions} function(s) from batch ${hit.map((x) => x.seq).join(', ')}; claims by ${issueRefs(r.collisions)}.${restaged(r.staged)}`;
  });
  const recheck = () => run('recheck', async () => {
    const r = await api.recheckWithheld(runId);
    return `${r.returnedTasks} held-back packet(s) are free again, ${r.stillWithheldTasks} still claimed${r.stillWithheldTasks ? ` (${issueRefs(r.collisions)})` : ''}.${restaged(r.staged)}`;
  });
  const restage = (b: Batch) => run(`restage-${b.id}`, async () => {
    const r = await api.restageBatch(runId, b.id);
    return r.seqs.length ? `Batch ${b.seq} was checked again as batch ${r.seqs.join(', ')}${r.failed ? ` (${r.failed} still failing)` : ''}.` : `Batch ${b.seq}: nothing was staged.`;
  });
  const restageFailed = () => run('restage-failed', async () => {
    const r = await api.restageFailed(runId);
    return `Failed batches checked again: ${r.staged} batch(es) made${r.failed ? `, ${r.failed} still failing` : ''}.`;
  });
  const describeUnits = (units: Record<string, string[]>) => Object.keys(units).map((u) => u.slice(u.lastIndexOf('/') + 1)).join(', ');
  const setAsideBlocking = (b: Batch) => run(`aside-${b.id}`, async () => {
    const r = await api.setAsideBlocking(runId, b.id);
    return `Batch ${b.seq}: set aside ${r.setAsideFunctions} function(s) in ${describeUnits(r.units)}.${r.keptTasks ? restaged(r.staged) : ''}${r.unattributed.length ? ` ${r.unattributed.length} finding(s) name no unit of the batch.` : ''}`;
  });
  const setAsideUpstream = () => run('upstream', async () => {
    const r = await api.setAsideUpstream(runId);
    const hit = r.batches.filter((x) => x.setAsideTasks);
    if (!hit.length) return `Checked ${r.batches.length} batch(es) against upstream: nothing to set aside.`;
    return `Set aside ${r.setAsideFunctions} function(s) upstream already has or changed, from batch ${hit.map((x) => x.seq).join(', ')}.${restaged(r.staged)}`;
  });
  const tidyPr = (b: Batch) => run(`tidy-${b.id}`, async () => {
    const r = await api.tidyPullRequest(runId, b.id);
    if (!r.ok) throw new Error(`Batch ${b.seq}'s pull request was not rewritten: ${r.error ?? 'unknown error'}`);
    return `Batch ${b.seq}'s pull request is now one commit titled "${r.title}".${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`;
  });
  const explain = (b: Batch) => run(`explain-${b.id}`, async () => {
    const r = await api.explainReview(runId, b.id);
    toggleExplain(`${b.id}:${r.key}`, false);
    return `Batch ${b.seq}: ${r.points.length} point(s) explained on its card${r.cached ? ' (unchanged since the last explanation)' : ''}.`;
  });
  const fixReview = (b: Batch) => run(`review-${b.id}`, async () => {
    const r = await api.fixFromReview(runId, b.id);
    return `Batch ${b.seq}: ${r.functions} function(s) in ${r.requeued} packet(s) went to the AI agents with ${r.comments} review comment(s) as instructions. The run is running again; ${r.open ? 'when it finishes, push the fixes to the same pull request from the new batch\'s card.' : 'when it finishes, everything is batched again for a new pull request.'}`;
  });
  const pushFixes = (b: Batch) => run(`push-${b.id}`, async () => {
    const r = await api.pushReviewFixes(runId, b.id);
    if (!r.ok) throw new Error(`Fixes not pushed: ${r.error ?? 'unknown error'}${r.problems.length ? ` — ${r.problems.slice(0, 3).join('; ')}` : ''}`);
    return `Fixes pushed to the pull request as ${r.commit?.slice(0, 10) ?? 'a new commit'}.`;
  });
  const refreshPrs = (b?: Batch) => run(b ? `prs-${b.id}` : 'prs', async () => {
    const r = await api.refreshPullRequests(runId, b?.id);
    const failed = r.pullRequests.filter((p) => p.error);
    return `Checked ${r.pullRequests.length} pull request(s) on GitHub: ${r.pullRequests.map((p) => `batch ${p.seq} ${p.state ?? 'unknown'}${p.comments ? ` (${p.comments} comment${p.comments === 1 ? '' : 's'})` : ''}`).join(', ')}.${failed.length ? ` Could not read ${failed.length}: ${failed[0]!.error}` : ''}`;
  });
  const rebalance = () => run('rebalance', async () => {
    const r = await api.rebalanceBatches(runId);
    return `Batch ${r.from.join(', ')} (${r.functions} functions) combined into ${r.staged.seqs.length === 1 ? `batch ${r.staged.seqs[0]}` : `batches ${r.staged.seqs.join(', ')}`}${r.staged.failed ? `; ${r.staged.failed} did not pass their check` : ''}. ${r.staged.seqs.length === 1 ? 'It needs' : 'They need'} a dry run again: Prepare all for PR does it.`;
  });
  const fix = (b: Batch) => run(`fix-${b.id}`, async () => {
    const r = await api.fixBatch(runId, b.id);
    return `Batch ${b.seq}: ${r.functions} function(s) in ${r.requeued} packet(s) went back to the AI agents with what its ${r.check === 're-verify' ? 'check' : 'dry run'} reported. The run is running again through its flow${r.kept ? `; its other ${r.kept} packet(s) stay matched` : ''}, and everything is batched again when it finishes.`;
  });
  const putBack = (units?: string[]) => run('put-back', async () => {
    const r = await api.putBackSetAside(runId, units);
    return `${r.returnedTasks} set-aside packet(s) put back.${restaged(r.staged)}`;
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Explanations this viewer closed (batch:comments key), kept in this browser; a new explanation opens again.
  const [closedExplain, setClosedExplain] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('closedExplanations') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleExplain = (id: string, close: boolean) => setClosedExplain((s) => {
    const n = new Set(s);
    if (close) n.add(id);
    else n.delete(id);
    try {
      localStorage.setItem('closedExplanations', JSON.stringify([...n].slice(-200)));
    } catch {
      /* private window: closed for this visit only */
    }
    return n;
  });
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
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
  const [nextLapse, setNextLapse] = useState<number | null>(null);
  useEffect(() => {
    if (!withheld) return setNextLapse(null);
    api.nextWithheldLapse(runId).then((r) => setNextLapse(r.at)).catch(() => undefined);
  }, [runId, withheld, batches]);

  // How the unsubmitted batches would combine into fewer, bigger ones (whole units, up to 60 functions).
  const [regroup, setRegroup] = useState<{ max: number; batches: Array<{ seq: number; functions: number }>; after: number[]; functions: number } | null>(null);
  useEffect(() => {
    if (!pipeline) return setRegroup(null);
    api.rebalancePlan(runId).then(setRegroup).catch(() => setRegroup(null));
  }, [runId, pipeline, batches]);

  // Pull requests on GitHub: read again quietly when the tab opens and the last read is a few minutes old.
  const prKey = batches.filter((b) => b.detail?.pr && b.detail.prUpdateOf === undefined).map((b) => b.id).join(',');
  useEffect(() => {
    if (!pipeline || !prKey) return;
    const stale = batches.some((b) => b.detail?.pr && b.detail.prUpdateOf === undefined && b.detail.prStatus?.state !== 'merged' && Date.now() - (b.detail.prStatus?.checkedAt ?? 0) > 3 * 60_000);
    if (stale) api.refreshPullRequests(runId).then(() => reloadRef.current()).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, pipeline, prKey]);

  const busyBatch = batches.some((b) => b.dryRunState);
  const locked = !!busy || busyBatch || !!op;
  const current = batches.filter((b) => b.status !== 'superseded');
  const history = batches.filter((b) => b.status === 'superseded').sort((x, y) => y.seq - x.seq);
  const views = new Map(current.map((b) => [b.id, batchView(b)]));
  const actionOf = (b: Batch) => views.get(b.id)!.action;
  const ready = current.filter((b) => actionOf(b) === 'submit');
  const needsWork = current.filter((b) => ['dry', 'drop', 'aside', 'restage'].includes(actionOf(b)));
  const failedCount = current.filter((b) => actionOf(b) === 'restage').length;
  const submitted = current.filter((b) => b.status === 'submitted');
  const prs = submitted.filter((b) => b.detail?.prUpdateOf === undefined);
  const merged = prs.filter((b) => b.detail?.prStatus?.state === 'merged');
  const openPrs = prs.filter((b) => !['merged', 'closed'].includes(b.detail?.prStatus?.state ?? ''));
  const order: Record<BatchAction, number> = { submit: 0, update: 0, aside: 1, drop: 1, restage: 1, dry: 2, none: 3 };
  const sorted = [...current].sort((x, y) => order[actionOf(x)] - order[actionOf(y)] || (x.status === 'submitted' ? 1 : 0) - (y.status === 'submitted' ? 1 : 0) || x.seq - y.seq);
  const fnCount = (list: Batch[]) => list.reduce((n, b) => n + (b.functions.length || b.detail?.functions || 0), 0);
  // Passed packets of a failed batch are that batch's to re-check; the rest have no batch at all.
  const inFailed = new Set(current.filter((b) => actionOf(b) === 'restage').flatMap((b) => b.functions.filter((f) => f.state === 'passed').map((f) => f.taskId)));
  // While the run goes on, only packets of finished units can be batched; with staging on, they
  // become batches on their own once they fill one, so the hero does not push a smaller batch.
  const looseNow = live ? batching?.fresh.packets ?? 0 : Math.max(0, passed - inFailed.size);
  const loose = live && batching?.rolling ? 0 : looseNow;

  const canRegroup = pipeline && !!regroup && regroup.batches.length > 1 && regroup.after.length < regroup.batches.length;
  const regroupButton = canRegroup && (
    <ConfirmButton className="big" disabled={locked} onConfirm={rebalance}
      confirmLabel={`Combine batch ${regroup!.batches.map((b) => b.seq).join(', ')} into ${regroup!.after.length}?`}
      title={`Fewer, bigger pull requests: the ${regroup!.batches.length} unsubmitted batches (${regroup!.functions} functions) become ${regroup!.after.length} of ${regroup!.after.join(' + ')} functions, whole units each, at most ${regroup!.max} per PR. Their local branches are replaced and the new batches are checked in a clean tree; they need a dry run again. Nothing is pushed.`}>
      {busy === 'rebalance' ? 'Combining…' : `Combine into ${regroup!.after.length === 1 ? 'one batch' : `${regroup!.after.length} batches`} (${regroup!.after.join(' + ')} functions)`}
    </ConfirmButton>
  );

  const hero = (() => {
    if (op) return <OperationPanel op={op} runId={runId} />;
    if (busy) return <div className="op-panel"><div className="op-head"><span className="spinner" aria-hidden="true" /><div className="op-step">Starting…</div></div></div>;
    if (!pipeline) return <div className="hero"><span className="eyebrow">PR batches</span><h3>No pull requests from this run</h3><p>The run is {status}: its matched functions are kept.</p></div>;
    if (needsWork.length || loose > 0) {
      return (
        <div className="hero">
          <span className="eyebrow">Next step</span>
          <h3>Get {needsWork.length ? (needsWork.length === 1 ? 'the batch' : `${needsWork.length} batches`) : 'the matched functions'} ready for pull requests</h3>
          <p>One click does everything below, in order, and shows its progress here:</p>
          <ol className="plan">
            {loose > 0 && <li>Batch the {loose} matched packet{loose === 1 ? '' : 's'} that have no batch yet, checking each batch in a clean tree.</li>}
            {live && batching?.rolling && batching.fresh.functions >= batching.batchSize && <li>Batch the ready functions that fill a batch.</li>}
            {failedCount > 0 && <li>Check {failedCount} failed batch{failedCount === 1 ? '' : 'es'} again in a clean tree.</li>}
            <li>Set aside what upstream already has or changed (seconds, no compiling).</li>
            <li>Dry-run each batch: only what changed is recompiled, on every idle slot at once.</li>
            <li>Hold back units someone else claimed, and set aside units a dry run blames; the rest is dry-run again.</li>
          </ol>
          <p>Nothing is pushed: you still submit each pull request yourself.{live ? ' The workers keep going meanwhile.' : ''}</p>
          <div className="row"><button className="primary big" disabled={locked} onClick={prepare}>Prepare all for PR</button>{regroupButton}{ready.length > 0 && <span className="muted small">{ready.length} batch{ready.length === 1 ? ' is' : 'es are'} already ready to submit.</span>}</div>
        </div>
      );
    }
    if (ready.length) {
      return (
        <div className="hero done">
          <span className="eyebrow">Ready</span>
          <h3>{ready.length} batch{ready.length === 1 ? '' : 'es'} ready to submit · {fnCount(ready)} functions</h3>
          <p>Each one passed a clean dry run. <b>Submit PR</b> on a card pushes that batch to your fork and opens one pull request upstream.</p>
          {regroupButton && <div className="row"><span className="muted small">Bigger PRs are better (up to {regroup!.max} functions):</span>{regroupButton}</div>}
        </div>
      );
    }
    if (submitted.length) return <div className="hero done"><span className="eyebrow">All done</span><h3>Every batch is submitted</h3><p>{submitted.length} pull request{submitted.length === 1 ? '' : 's'} open.{withheld + setAside ? ' Some packets are still held back: see below.' : ''}</p></div>;
    if (live) return null; // the next-batch meter says what comes next
    return <div className="hero"><span className="eyebrow">PR batches</span><h3>Nothing to submit right now</h3><p>{withheld + setAside ? 'Everything left is held back: see below.' : 'This run has no batches waiting.'}</p></div>;
  })();

  const primary = (b: Batch) => {
    const v = views.get(b.id)!;
    const d = b.detail;
    if (b.dryRunState || busy === `dry-${b.id}`) {
      return <button disabled={b.dryRunState !== 'running' || cancelling === b.id} onClick={() => cancel(b)}>{b.dryRunState === 'cancelling' || cancelling === b.id ? 'Cancelling…' : 'Cancel dry run'}</button>;
    }
    switch (v.action) {
      case 'submit': return <ConfirmButton className="primary" disabled={locked} onConfirm={() => submit(b, true)} confirmLabel="Push to your fork and open the PR?" title="Runs sr submit: pushes the branch to your fork and opens one pull request upstream">{busy === `submit-${b.id}` ? 'Submitting…' : 'Submit PR'}</ConfirmButton>;
      case 'dry': return <button className="primary" disabled={locked} onClick={() => submit(b, false)}>Dry run</button>;
      case 'drop': return <ConfirmButton className="primary" disabled={locked} onConfirm={() => dropCollisions(b)} confirmLabel="Check claims and hold back claimed units?" title="Checks GitHub again; units with a function someone else claimed are held back (your local claims stay), and the rest becomes a new batch. Nothing is pushed.">{busy === `drop-${b.id}` ? 'Checking claims…' : 'Hold back claimed units'}</ConfirmButton>;
      case 'aside': return <ConfirmButton className="primary" disabled={locked} onConfirm={() => setAsideBlocking(b)} confirmLabel="Set aside the units the findings name?" title="Holds the units the last dry run's findings name out of PRs and checks the rest as a new batch">{busy === `aside-${b.id}` ? 'Setting aside…' : 'Set aside blocking units'}</ConfirmButton>;
      case 'update': return <ConfirmButton className="primary" disabled={locked} onConfirm={() => pushFixes(b)} confirmLabel={`Push the fixes to ${prRef(b)} as one more commit?`} title="Checks every packet of the pull request again with the fixes in a clean tree, then pushes one more commit to its branch on your fork (a fast-forward, never a force-push). Refused if the PR was closed or anyone else pushed to it.">{busy === `push-${b.id}` ? 'Pushing…' : `Push the fixes to ${prRef(b)}`}</ConfirmButton>;
      case 'restage': return <ConfirmButton className="primary" disabled={locked} onConfirm={() => restage(b)} confirmLabel={`Check batch ${b.seq} again?`} title="Re-verifies exactly this batch's packets in a clean tree and commits a new local branch. Nothing is pushed.">{busy === `restage-${b.id}` ? 'Checking…' : 'Check again'}</ConfirmButton>;
      default:
        return d?.pr ? <a href={d.pr} target="_blank" rel="noreferrer">Open the pull request ↗</a> : d?.link ? <a href={d.link} target="_blank" rel="noreferrer">Open the PR by hand ↗</a> : null;
    }
  };

  const card = (b: Batch) => {
    const v = views.get(b.id)!;
    const d = b.detail;
    const last = d?.lastSubmit;
    const unchecked = d?.dryRunUncheckedClaims ?? [];
    const canOverride = !!d?.dryRunFingerprint && unchecked.length > 0;
    const canClear = b.status === 'branch_ready' && b.branch?.startsWith('decomp/') && !d?.pr && !d?.link && (last?.dryRun !== false || last.submissionStarted === false);
    const findings = last && !last.ok ? [...last.problems, ...last.blockers, ...(last.uncheckedClaims ?? []), ...(last.error && !last.problems.length && !last.blockers.length ? [last.error] : [])] : [];
    const units = new Set(b.functions.map((f) => f.unit)).size;
    const idle = !(b.dryRunState || busy === `dry-${b.id}`);
    // A failed check the code can fix: re-verification, or dry-run findings other than claims and upstream.
    // Findings in a file the batch does not write are not the agents' to fix: they never see that file.
    const notOurs = new Set(b.outside ?? []);
    const fixable = pipeline && idle && (b.status === 'failed' || (b.status === 'branch_ready' && !!last?.dryRun && !last.ok && findings.some((x) => !isClaimBlocker(x) && !/upstream/i.test(x) && !notOurs.has(x))));
    const fixButton = fixable && (
      <ConfirmButton className="" disabled={locked} onConfirm={() => fix(b)} confirmLabel={live ? 'Send the failing packets back to the AI agents? The run picks them up.' : 'Send the failing packets back to the AI agents? The run starts again.'}
        title="The packets this check failed go back to the run's AI workers, at the tier that matched them, with what the check reported; they run through the flow again (workers, Gate Keeper, escalation). The other packets stay matched, and everything is batched and checked again when the run finishes. Nothing is pushed.">
        {busy === `fix-${b.id}` ? 'Sending to the agents…' : 'Fix with AI agents'}
      </ConfirmButton>
    );
    // A pull request on GitHub: its comments, explained or fixed from.
    const hasPr = b.status === 'submitted' && !!d?.pr && d.prUpdateOf === undefined;
    const review = hasPr ? reviewOf(b) : [];
    const prState = d?.prStatus?.state ?? null;
    const explainId = d?.prExplain ? `${b.id}:${d.prExplain.key}` : '';
    const explainClosed = !!explainId && closedExplain.has(explainId);
    const reviewButtons = review.length > 0 && (
      <>
        {explainClosed
          ? <button onClick={() => toggleExplain(explainId, false)} title="Shows the saved explanation again (no new model call)">Show the explanation</button>
          : <button disabled={locked} onClick={() => explain(b)} title="One short model call reads the comments and explains each one in plain words: what it is about, what it means, and what to do. Unchanged comments reuse the saved explanation.">{busy === `explain-${b.id}` ? 'Reading the comments…' : d?.prExplain ? 'Explain again' : 'Explain the comments'}</button>}
        {pipeline && prState && prState !== 'merged' && !d?.reviewFix && (
          <ConfirmButton className="" disabled={locked} onConfirm={() => fixReview(b)}
            confirmLabel={`Send the ${review.length} comment(s) to the AI agents as instructions? ${live ? 'The run picks them up.' : 'The run starts again.'}`}
            title={prState === 'open'
              ? 'The packets the comments are about go back to the run\'s AI workers with the comments as instructions, through the whole flow (Gate Keeper, escalation). When the run finishes, you push the fixes to this same pull request as one more commit.'
              : 'The pull request is closed: the packets the comments are about go back to the AI workers with the comments as instructions, the others are batched again with them, and the result becomes a new pull request (dry run, then Submit).'}>
            {busy === `review-${b.id}` ? 'Sending to the agents…' : 'Fix from the comments'}
          </ConfirmButton>
        )}
      </>
    );
    const explained = hasPr && d?.prExplain && !explainClosed && (
      <div className="explain">
        <div className="row"><b className="small grow">What the comments mean</b><button className="tiny" onClick={() => toggleExplain(explainId, true)} aria-label="Close the explanation" title="Hide it; Show the explanation brings it back without a new model call">✕ Close</button></div>
        <p>{d.prExplain.summary}</p>
        {d.prExplain.points.length > 0 && (
          <ul>
            {d.prExplain.points.map((pt, i) => (
              <li key={i}><b>{pt.author}</b>{pt.about ? <span className="muted"> · {pt.about}</span> : null}<div>{pt.plain}</div>{pt.action && <div className="todo">→ {pt.action}</div>}</li>
            ))}
          </ul>
        )}
        {d.prExplain.nextStep && <p className="small"><b>Next:</b> {d.prExplain.nextStep}</p>}
        <span className="muted small">Explained {new Date(d.prExplain.at).toLocaleString()} by {d.prExplain.model}</span>
      </div>
    );
    return (
      <article key={b.id} className="bcard" aria-label={`Batch ${b.seq}`}>
        <div className="top"><h4>Batch {b.seq}</h4><span className="muted small grow">{b.functions.length || d?.functions || '?'} functions{units ? ` · ${units} unit${units === 1 ? '' : 's'}` : ''}</span></div>
        <div className={`state ${v.tone}`}>{v.title}</div>
        <p className="why">{v.why}</p>
        <StepDots steps={v.steps} />
        {explained}
        <div className="actions">{primary(b)}{fixButton}{reviewButtons}{d?.claims?.length ? <span className="small">Claim: {d.claims.map((u, i) => <span key={u}>{i ? ', ' : ''}<a href={u} target="_blank" rel="noreferrer">{issueNo(u)} ↗</a></span>)}</span> : null}</div>
        <details className="more">
          <summary>Details and more actions</summary>
          <div className="stack" style={{ gap: 10, marginTop: 8 }}>
            {findings.length > 0 && (
              <div>
                <b className="small">What the last {last?.dryRun ? 'dry run' : 'submission'} found</b>
                <ul className="findings">{findings.slice(0, 12).map((x) => <li key={x}>{x}{notOurs.has(x) && <span className="chip" style={{ marginLeft: 6 }} title="An upstream file that includes a header this batch changes: not in any packet of the batch">not in this batch</span>}</li>)}</ul>
                {findings.length > 12 && <span className="muted small">and {findings.length - 12} more</span>}
              </div>
            )}
            {d?.problems?.length ? <div className="small"><b>Check problems:</b> {d.problems.join('; ')}</div> : null}
            {hasPr && (
              <div>
                <div className="row">
                  <b className="small grow">
                    On GitHub: {prState ?? 'not read yet'}
                    {d?.prStatus?.checkedAt ? <span className="muted"> · checked {new Date(d.prStatus.checkedAt).toLocaleTimeString()}</span> : null}
                    {d?.prStatus?.error ? <span className="muted"> · {d.prStatus.error}</span> : null}
                  </b>
                  <button className="tiny" disabled={locked} onClick={() => refreshPrs(b)}>{busy === `prs-${b.id}` ? 'Checking…' : 'Check GitHub now'}</button>
                </div>
                {review.length ? (
                  <ul className="comments">
                    {review.map((c) => (
                      <li key={c.id}>
                        <b>{c.author ?? 'someone'}</b>{c.bot ? <span className="chip">bot</span> : null}
                        <span className="muted small"> · {c.kind === 'inline' ? `on ${c.path}${c.line ? `:${c.line}` : ''}` : c.kind === 'review' ? `review${c.reviewState ? ` (${c.reviewState.toLowerCase().replace(/_/g, ' ')})` : ''}` : 'comment'} · {shortDate(c.at)} · <a href={c.url} target="_blank" rel="noreferrer">open ↗</a></span>
                        <div className="small">{commentText(c.body).slice(0, 500) || '(no text)'}{commentText(c.body).length > 500 ? '…' : ''}</div>
                      </li>
                    ))}
                  </ul>
                ) : <span className="muted small">No comments from others{d?.prStatus ? '' : ' yet (not read from GitHub yet)'}.</span>}
                {d?.prUpdates?.length ? <div className="muted small">Fixes pushed: {d.prUpdates.map((u) => `${u.commit?.slice(0, 10) ?? '?'} (batch ${u.seq})`).join(', ')}</div> : null}
              </div>
            )}
            <div className="muted small">
              {b.branch && <div>Branch <span className="mono">{b.branch}</span></div>}
              {d?.draftedBy && <div>Drafted by {d.draftedBy}</div>}
              {last && <div>Last {last.dryRun ? 'dry run' : 'submit'}: {new Date(last.at).toLocaleString()} — {last.cancelled ? 'cancelled' : last.ok ? 'clean' : 'problems'}{last.compared != null ? ` · ${last.compared} recompiled, ${last.reused ?? 0} unchanged` : ''}{last.durationMs != null ? ` · took ${fmtDuration(last.durationMs)}` : ''}</div>}
              {last?.warnings.length ? <details><summary>{last.warnings.length} warning(s)</summary><ul className="findings">{last.warnings.map((x) => <li key={x}>{x}</li>)}</ul></details> : null}
              {last?.plan.length ? <details><summary>sr submit plan</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{last.plan.join('\n')}</pre></details> : null}
            </div>
            {b.status === 'branch_ready' && idle && (
              <div className="row">
                {v.action !== 'dry' && <button className="tiny" disabled={locked} onClick={() => submit(b, false)}>Dry run again</button>}
                {v.action !== 'drop' && <ConfirmButton className="tiny" disabled={locked} onConfirm={() => dropCollisions(b)} confirmLabel="Check claims now?" title="Checks GitHub for other contributors' claims on this batch and holds back claimed units">Check claims</ConfirmButton>}
                {v.action !== 'aside' && findings.some((x) => !isClaimBlocker(x)) && <ConfirmButton className="tiny" disabled={locked} onConfirm={() => setAsideBlocking(b)} confirmLabel="Set aside the units the findings name?">Set aside blocking units</ConfirmButton>}
                {canOverride && <ConfirmButton className="tiny" disabled={locked} onConfirm={() => submit(b, true, true)} confirmLabel={`Submit with ${unchecked.length} task(s) unchecked?`} title={`Not checked: ${unchecked.join('; ')}. The submission probes again and still refuses any known collision.`}>Submit with unchecked claims</ConfirmButton>}
                {canClear && (last?.dryRun || d?.dryRunFingerprint) && <ConfirmButton className="tiny" disabled={locked} onConfirm={() => clear(b, 'preview')} confirmLabel="Clear the dry run?">Clear dry run</ConfirmButton>}
                {canClear && <ConfirmButton className="tiny danger" disabled={locked} onConfirm={() => clear(b, 'batch')} confirmLabel="Delete its local branches?">Delete branch</ConfirmButton>}
              </div>
            )}
            {hasPr && d?.prBranch && !['merged', 'closed'].includes(prState ?? '') && (units > 1 || !d.claims?.length) && (
              <div className="row">
                <ConfirmButton className="tiny" disabled={locked} onConfirm={() => tidyPr(b)} confirmLabel="Rewrite the PR as one commit (force-push)?" title="Squashes the PR branch into one commit, retitles the commit and the pull request with every function of the batch, and opens the claim issue for them if it has none (linked both ways). Refused for a merged or closed PR, or if anyone else pushed to the branch.">{busy === `tidy-${b.id}` ? 'Rewriting…' : d.tidiedAt ? 'Rewrite the PR again' : units > 1 ? 'One commit, every function, and its claim' : 'Open its claim issue'}</ConfirmButton>
                {d.prTitle && <span className="muted small">Title: {d.prTitle}</span>}
              </div>
            )}
            {b.functions.length > 0 && (
              <div>
                <button className="link" onClick={() => toggle(b.id)}>{open.has(b.id) ? 'Hide functions' : `Show its ${b.functions.length} functions`}</button>
                {open.has(b.id) && <div style={{ overflowX: 'auto' }}><BatchFunctions b={b} /></div>}
              </div>
            )}
          </div>
        </details>
      </article>
    );
  };

  return (
    <div className="stack">
      {live && batching && <RollingMeter b={batching} status={status} locked={locked} busy={busy === 'stage'} onBatchNow={stage} />}
      {hero}
      {msg && <div className="notice" role="status">{msg}</div>}
      {err && <div className="notice error" role="alert">{err}</div>}
      {current.length > 0 && (
        <div className="tiles">
          <div className="tile ok"><b>{ready.length}</b><span>ready to submit</span></div>
          <div className={`tile ${needsWork.length ? 'next' : ''}`}><b>{needsWork.length}</b><span>need a dry run or a fix</span></div>
          <div className={`tile ${withheld + setAside ? 'warn' : ''}`}><b>{fmtCount(heldFunctions)}</b><span>functions held back · {withheld + setAside} packet{withheld + setAside === 1 ? '' : 's'}</span></div>
          <div className="tile ok"><b>{openPrs.length}</b><span>pull requests open</span></div>
          {merged.length > 0 && <div className="tile ok"><b>{merged.length}</b><span>merged upstream</span></div>}
        </div>
      )}
      {sorted.length > 0 && <div className="cards">{sorted.map(card)}</div>}
      <HeldBackKpis batches={batches} />
      {(withheld > 0 || setAside > 0) && (
        <div className="panel stack">
          <div><h2 style={{ marginBottom: 4 }}>Held back</h2><span className="muted">These matched but are kept out of pull requests for now. Nothing is lost.</span></div>
          <div className="held">
            {withheld > 0 && (
              <div className="group">
                <div className="row"><b className="grow">{withheld} packet{withheld === 1 ? '' : 's'} claimed by someone else</b><button className="tiny" disabled={locked} onClick={recheck}>{busy === 'recheck' ? 'Checking…' : 'Recheck now'}</button></div>
                <span className="muted small">
                  Another contributor's open claim or PR names a function in their unit. The server checks again on its own{nextLapse ? (nextLapse <= Date.now() ? ': a claim has lapsed, so within minutes.' : ` when the first claim lapses, in ${fmtDuration(nextLapse - Date.now())}.`) : ' when their claims lapse.'}
                </span>
                <WithheldList batches={batches} />
              </div>
            )}
            {setAside > 0 && (
              <div className="group">
                <b>{setAside} packet{setAside === 1 ? '' : 's'} set aside</b>
                <div className="muted small">They blocked a dry run, or upstream already has them. Put a unit back once its cause is gone.</div>
                <SetAsideList batches={batches} locked={locked} busy={busy} putBack={putBack} />
              </div>
            )}
          </div>
        </div>
      )}
      {pipeline && (current.some((b) => b.status === 'branch_ready') || looseNow > 0 || failedCount > 0) && (
        <details className="panel flat">
          <summary><b>Run one step yourself</b> <span className="muted small">what Prepare all for PR does, one piece at a time</span></summary>
          <div className="row" style={{ marginTop: 12 }}>
            {looseNow > 0 && <button disabled={locked} onClick={stage} title={live ? 'Batch the matched packets of finished units now, without waiting for a full batch, and check each batch in a clean tree' : 'Group matched packets that have no batch into batches and check each in a clean tree'}>{live && batching?.rolling ? `Batch the ${looseNow} ready packet${looseNow === 1 ? '' : 's'} now` : 'Batch matched packets'}</button>}
            {failedCount > 0 && <ConfirmButton className="" disabled={locked} onConfirm={restageFailed} confirmLabel="Check every failed batch again?">Check failed batches again</ConfirmButton>}
            <ConfirmButton className="" disabled={locked} onConfirm={setAsideUpstream} confirmLabel="Check every batch against upstream?" title="Reads upstream's data/progress.json and the files each batch writes (seconds, no compiling) and sets aside what it already has or changed">Check against upstream</ConfirmButton>
            <ConfirmButton className="" disabled={locked} onConfirm={dropAll} confirmLabel="Check claims for every batch?" title="One GitHub claims check for every unsubmitted batch; claimed units are held back and the rest restaged. Nothing is pushed.">Check claims in all batches</ConfirmButton>
          </div>
        </details>
      )}
      {history.length > 0 && (
        <details className="panel flat history">
          <summary>History: {history.length} replaced batch{history.length === 1 ? '' : 'es'}</summary>
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table>
              <thead><tr><th>#</th><th>Functions</th><th>What happened</th></tr></thead>
              <tbody>
                {history.map((b) => (
                  <tr key={b.id}>
                    <td>{b.seq}</td>
                    <td>{b.functions.length || b.detail?.functions || '?'}</td>
                    <td className="small">{batchView(b).why}{b.detail?.withheld ? ` Claimed in ${issueRefs(b.detail.claimCheck?.collisions ?? {})}.` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
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
const ACCOUNT_STATE: Record<string, string> = {
  disabled: 'disabled', circuit_open: 'failing (circuit open)', quota_exhausted: 'out of quota', cooling: 'rate limited',
};

/** Paused by the server because every AI account the workers use is down; resumed by it too. */
function OutageBanner({ o }: { o: RunOutage }) {
  const now = useNow(true);
  const onlyYou = o.nextBackAt === null;
  return (
    <div className="notice lvl-warn" role="status">
      <b>No AI account can work right now, so the run is paused.</b> It resumes on its own as soon as one is back{o.nextBackAt ? (o.nextBackAt > now ? `: the first should be back in ${fmtDuration(o.nextBackAt - now)}` : ': checking now') : ''}. Packets are not charged for the outage. Paused {fmtDuration(Math.max(0, now - o.since))} ago.
      <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {o.accounts.map((a) => (
          <li key={a.id}><span className="mono">{a.id}</span>: {ACCOUNT_STATE[a.status] ?? a.status}{a.until ? `, back ${a.until > now ? `in ${fmtDuration(a.until - now)}` : 'now'}` : a.status === 'disabled' ? ': enable it on the Accounts page' : ''}{a.reason ? <span className="muted"> · {a.reason.slice(0, 160)}</span> : null}</li>
        ))}
      </ul>
      {onlyYou && <div className="small" style={{ marginTop: 6 }}>Every account is disabled, so only you can bring one back: fix it and enable it on the Accounts page, and the run resumes by itself.</div>}
    </div>
  );
}

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
