// SPDX-License-Identifier: AGPL-3.0-or-later
// Skills & optimization: the registry (active / candidate / core / deprecated), what each skill costs
// and earns (tokens, trigger frequency, pass-rate lift against its held-out control group), the
// curator's one-click workflows, and every proposed SKILL.md change with its before/after diff and
// shadow-evaluation result.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeTrigger, type Skill, type SkillEvalRun, type SkillStatus } from '@decomp/skills';
import { api, stream, type SkillDetail, type SkillProposal, type SkillsOverview } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';
import { Diff } from '../components/Diff';

const STATUS_LABEL: Record<SkillStatus, string> = { promoted_to_core: 'core', active: 'active', candidate: 'candidate', deprecated: 'deprecated' };
const FILTERS: Array<SkillStatus | 'all'> = ['all', 'promoted_to_core', 'active', 'candidate', 'deprecated'];

export default function Skills() {
  const [o, setO] = useState<SkillsOverview | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<SkillStatus | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [github, setGithub] = useState(false);

  const refresh = useCallback(() => api.skills().then((x) => { setO(x); setErr(''); }).catch((e) => setErr(String(e))), []);
  useEffect(() => {
    refresh();
    const off = stream(null, { event: (e) => { if (e.kind.startsWith('skills.')) { setNote(e.msg); refresh(); } } });
    return off;
  }, [refresh]);
  useEffect(() => {
    if (!o?.curator.busy) return;
    const t = setInterval(refresh, 2_000);
    return () => clearInterval(t);
  }, [o?.curator.busy, refresh]);

  const job = async (kind: Parameters<typeof api.skillJob>[0], body: Record<string, unknown> = {}) => {
    try {
      await api.skillJob(kind, body);
      setNote(`${kind} started…`);
      refresh();
    } catch (e) {
      setNote(String((e as Error).message));
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of o?.skills ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [o]);
  if (!o) return <div className="page">{err ? <span className="lvl-error">{err}</span> : 'Loading…'}</div>;

  const busy = o.curator.busy;
  const shown = o.skills.filter((s) => filter === 'all' || s.status === filter);
  const coverage = new Map((o.lastRun?.skills ?? []).map((s) => [s.skillId, s]));
  const spend = o.jobs.reduce((s, j) => s + j.costUsd, 0);
  const accepted = o.evals.filter((e) => e.decision === 'accept').length;
  const rejected = o.evals.filter((e) => e.decision === 'reject').length;

  return (
    <div className="page" style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Skills &amp; optimization</h2>
          {busy ? <span className="chip running">curator: {busy}…</span> : <span className="chip">curator idle</span>}
          {!o.curator.modelAvailable && <span className="chip warn" title="Mining, model-drafted triggers and patches need a frontier/orchestrator model in the pool">no curator model</span>}
          {!o.curator.engineIdle && <span className="chip warn" title="Shadow evaluation uses the worktree slots; proposals wait until the run finishes">run active: shadow evaluation waits</span>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={!!busy || !o.lastRun} title={o.lastRun ? `Retry wins of ${o.lastRun.name}` : 'No finished run yet'} onClick={() => job('mine', { runId: o.lastRun?.id })}>Mine skills from last run</button>
          <button disabled={!!busy} onClick={() => job('optimize', { runId: o.lastRun?.id })} title="Promote skills that fire on >25% of a run into the cached prefix, compress bloated bodies, deprecate skills with negative lift">Optimize &amp; compress</button>
          <button disabled={!!busy} onClick={() => job('update', { runId: o.lastRun?.id })} title="Failure clusters (≥3 injected failures with one code) → version + 1">Patch failure clusters</button>
          <button disabled={!!busy || !o.proposals.length} onClick={() => job('shadow')}>Shadow-evaluate pending ({o.proposals.length})</button>
          <span className="grow" />
          <label className="inline" title="Also cluster PR review comments via your gh login (synthesised by the curator model)"><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} />PR history</label>
          <button disabled={!!busy} onClick={() => job('bootstrap', { github, evaluate: true })}>Bootstrap from repo history</button>
          <button disabled={!!busy} onClick={() => job('curate', { runId: o.lastRun?.id })} title="mine → patch → optimize → shadow-evaluate">Run full curation</button>
          <button onClick={() => api.importSkills().then((r) => { setNote(`imported ${r.created.length} new, ${r.proposed.length} edit(s) proposed${r.problems.length ? `; ${r.problems.length} problem(s): ${r.problems[0]}` : ''}`); refresh(); })} title="Read hand-written or edited SKILL.md files from the skills folder">Import SKILL.md</button>
        </div>
        {note && <div className="muted mono" style={{ marginTop: 8 }}>{note}</div>}
        <div className="kpis" style={{ marginTop: 12 }}>
          <Kpi l="Core (cached prefix)" v={counts.promoted_to_core ?? 0} sub={`${o.nextRun.core.reduce((s, c) => s + c.tokens, 0)} tok next run`} />
          <Kpi l="Active (dynamic)" v={counts.active ?? 0} />
          <Kpi l="Candidates" v={counts.candidate ?? 0} />
          <Kpi l="Deprecated" v={counts.deprecated ?? 0} />
          <Kpi l="Pending proposals" v={o.proposals.length} c={o.proposals.length ? 'var(--warn)' : undefined} />
          <Kpi l="Shadow evals" v={`${accepted} ✓ / ${rejected} ✗`} sub={`curator spend $${spend.toFixed(2)}`} />
        </div>
      </div>

      {o.proposals.length > 0 && (
        <div className="panel">
          <h2>Proposed SKILL.md changes</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
            {o.proposals.map((p) => <ProposalCard key={`${p.skill.id}@${p.version.version}`} p={p} busy={!!busy} onChange={refresh} />)}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Registry</h2>
          <div className="toggle-row">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? `all ${o.skills.length}` : `${STATUS_LABEL[f]} ${counts[f] ?? 0}`}
              </button>
            ))}
          </div>
        </div>
        {o.lastRun && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Coverage = share of functions in packets where the skill fired, in the last finished run ({o.lastRun.name}, {o.lastRun.totalFunctions} functions). Above 25% an active skill is promoted into the cached prefix.</div>}
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Skill</th><th>Status</th><th>Tokens</th><th>Triggers</th><th>Coverage</th><th>Fired</th><th>Pass rate</th><th>Lift</th><th /></tr></thead>
          <tbody>
            {shown.map((s) => {
              const t = s.telemetry;
              const done = t.passCount + t.failCount;
              const cov = coverage.get(s.id);
              return (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(s.id)}>
                  <td><b>{s.name}</b><div className="muted" style={{ fontSize: 11 }}>{s.origin.replace('_', ' ')} · v{s.version}{s.statusReason ? ` · ${s.statusReason.slice(0, 90)}` : ''}</div></td>
                  <td><StatusChip s={s.status} /></td>
                  <td className="mono">{s.tokenCount}</td>
                  <td className="mono" style={{ fontSize: 11, maxWidth: 320 }}>{describeTrigger(s.triggers)}</td>
                  <td>{cov ? <CoverageBar v={cov.coverage} /> : <span className="muted">—</span>}</td>
                  <td className="mono">{t.triggerCount}<div className="muted" style={{ fontSize: 11 }}>{t.injectCount} injected · {t.holdoutCount} held out</div></td>
                  <td className="mono">{done ? `${Math.round((t.passCount / done) * 100)}%` : '—'}{t.holdoutCount ? <div className="muted" style={{ fontSize: 11 }}>control {t.holdoutPassCount}/{t.holdoutCount}</div> : null}</td>
                  <td><Lift v={t.lift} method={t.liftMethod} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {s.status === 'active' && <ConfirmButton className="" onConfirm={() => api.skillStatus(s.id, 'deprecated').then(refresh)}>Deprecate</ConfirmButton>}
                    {s.status === 'promoted_to_core' && <button onClick={() => api.skillStatus(s.id, 'active').then(refresh)} title="Back to dynamic injection (takes effect next run)">Demote</button>}
                    {s.status === 'deprecated' && s.statusReason?.startsWith('rejected') && (
                      <button title="Shadow evaluations are small; send this candidate back for another one" onClick={() => api.skillVersionAction(s.id, s.version, 'reopen').then(refresh).catch((e) => setNote(String(e.message)))}>Re-open</button>
                    )}
                    {s.status === 'deprecated' && !s.statusReason?.startsWith('rejected') && <button onClick={() => api.skillStatus(s.id, 'active').then(refresh).catch((e) => setNote(String(e.message)))}>Reactivate</button>}
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={9} className="muted">No skills here yet. Bootstrap from the repository's cookbook, or mine a finished run.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Shadow evaluations</h2>
          <table>
            <thead><tr><th>Skill</th><th>Result</th><th>Baseline → candidate</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              {o.evals.slice(0, 12).map((e) => <EvalRow key={e.id} e={e} name={o.skills.find((s) => s.id === e.skillId)?.name ?? e.skillId} />)}
              {!o.evals.length && <tr><td colSpan={5} className="muted">None yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Curator jobs</h2>
          <div className="log">
            {o.jobs.map((j) => (
              <div key={j.id}>
                <span className={`chip ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'error' : 'running'}`}>{j.kind}</span>{' '}
                {new Date(j.startedAt).toLocaleTimeString()} {j.error ? <span className="lvl-error">{j.error}</span> : <span className="muted">{jobLine(j.summary)}</span>} {j.costUsd ? `· $${j.costUsd.toFixed(3)}` : ''}
              </div>
            ))}
            {!o.jobs.length && <div className="muted">No jobs yet.</div>}
          </div>
        </div>
      </div>
      {open && <SkillDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ProposalCard({ p, busy, onChange }: { p: SkillProposal; busy: boolean; onChange: () => void }) {
  const e = p.evalRun;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="row">
        <b className="grow">{p.version.name} <span className="muted">v{p.version.version}</span></b>
        <span className="chip">{p.version.changeKind}</span>
        <span className="chip warn">{p.current ? `replaces v${p.current.version}` : 'new skill'}</span>
        <span className="mono muted">{p.current ? `${p.current.tokenCount} → ` : ''}{p.version.tokenCount} tok</span>
      </div>
      {p.version.rationale && <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{p.version.rationale}</div>}
      <Diff before={p.diff.before ?? ''} after={p.diff.after ?? ''} />
      <div className="row" style={{ marginTop: 8 }}>
        {e ? (
          <span className="grow" style={{ fontSize: 12, flexBasis: '16rem' }}>
            <span className={`chip ${e.status === 'running' ? 'running' : e.status === 'error' ? 'error' : e.decision ?? ''}`}>{e.status}</span>{' '}
            {e.cases ? `${e.baselinePass}/${e.cases} → ${e.candidatePass}/${e.cases} pass` : ''} <span className="muted">{e.reason}</span>
          </span>
        ) : <span className="grow muted" style={{ fontSize: 12 }}>Not evaluated yet. Only a shadow evaluation can activate it.</span>}
        <button className="primary" disabled={busy} onClick={() => api.skillVersionAction(p.skill.id, p.version.version, 'evaluate').then(onChange)}>Run shadow evaluation</button>
        <ConfirmButton disabled={busy} onConfirm={() => api.skillVersionAction(p.skill.id, p.version.version, 'reject').then(onChange)}>Discard</ConfirmButton>
      </div>
    </div>
  );
}

function SkillDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<SkillDetail | null>(null);
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    api.skill(id).then((x) => { setD(x); setV(x.skill.version); });
  }, [id]);
  if (!d) return <div className="drawer">Loading…</div>;
  const cur = d.versions.find((x) => x.version === v) ?? d.versions[0];
  const prev = cur ? d.versions.find((x) => x.version === (cur.parentVersion ?? cur.version - 1)) : null;
  const ev = d.evals.find((e) => e.version === cur?.version);
  return (
    <div className="drawer" role="dialog" aria-label={`Skill ${d.skill.name}`}>
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{d.skill.name}</h2><StatusChip s={d.skill.status} /><button onClick={onClose}>Close</button></div>
      <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
        {d.skill.origin.replace('_', ' ')} · current v{d.skill.version} · lift {d.lift.lift === null ? 'n/a' : `${d.lift.lift >= 0 ? '+' : ''}${d.lift.lift}`} ({d.lift.method}, {d.lift.treated} treated / {d.lift.control} control)
      </div>
      <div className="toggle-row">
        {d.versions.map((x) => <button key={x.version} className={x.version === cur?.version ? 'on' : ''} onClick={() => setV(x.version)}>v{x.version} · {x.state}</button>)}
      </div>
      {cur && (
        <>
          <h3>SKILL.md {prev ? `(diff vs v${prev.version})` : ''}</h3>
          {prev ? <Diff before={prev.md ?? ''} after={cur.md ?? ''} /> : <pre className="diffview" style={{ padding: 8 }}>{cur.md}</pre>}
          {cur.rationale && <p className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{cur.rationale}</p>}
        </>
      )}
      {ev && (
        <>
          <h3>Shadow evaluation of v{ev.version}</h3>
          <div style={{ fontSize: 12 }}><span className={`chip ${ev.decision ?? ev.status}`}>{ev.decision ?? ev.status}</span> {ev.reason}</div>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>Case</th><th>Why</th><th>Baseline</th><th>Candidate</th></tr></thead>
            <tbody>
              {ev.details.map((c, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 11 }}>{c.label}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{c.why}</td>
                  <td>{c.baseline.error ? <span className="chip error" title={c.baseline.error}>error</span> : <span className={`chip ${c.baseline.pass ? 'pass' : 'reject'}`}>{c.baseline.pass ? 'pass' : `${c.baseline.exactBytes} B`}</span>}</td>
                  <td>{c.candidate.error ? <span className="chip error" title={c.candidate.error}>error</span> : <span className={`chip ${c.candidate.pass ? 'pass' : 'reject'}`}>{c.candidate.pass ? 'pass' : `${c.candidate.exactBytes} B`}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function EvalRow({ e, name }: { e: SkillEvalRun; name: string }) {
  return (
    <tr title={e.reason ?? ''}>
      <td>{name} <span className="muted">v{e.version}</span></td>
      <td><span className={`chip ${e.status === 'running' ? 'running' : e.status === 'error' ? 'error' : e.decision ?? ''}`}>{e.decision ?? e.status}</span></td>
      <td className="mono">{e.cases ? `${e.baselinePass}/${e.cases} → ${e.candidatePass}/${e.cases}` : '—'}</td>
      <td className="mono">{e.cases ? `${Math.round(e.baselineTokens / e.cases)} → ${Math.round(e.candidateTokens / e.cases)}` : '—'}</td>
      <td className="mono">${e.costUsd.toFixed(3)}</td>
    </tr>
  );
}

function StatusChip({ s }: { s: Skill['status'] }) {
  const cls = s === 'promoted_to_core' ? 'ok' : s === 'active' ? 'running' : s === 'candidate' ? 'warn' : 'cancelled';
  return <span className={`chip ${cls}`}>{STATUS_LABEL[s]}</span>;
}

function Lift({ v, method }: { v: number | null; method: string }) {
  if (v === null) return <span className="muted" title="Not enough injected or held-out attempts yet">—</span>;
  const pts = Math.round(v * 100);
  return <span className="mono" style={{ color: pts > 0 ? 'var(--ok)' : pts < 0 ? 'var(--bad)' : undefined }} title={method === 'holdout' ? 'vs the deterministic held-out control group' : 'vs non-eligible attempts (confounded)'}>{pts > 0 ? '+' : ''}{pts} pts<span className="muted" style={{ fontSize: 10 }}> {method}</span></span>;
}

function CoverageBar({ v }: { v: number }) {
  return (
    <div className="meter" style={{ minWidth: 90 }}>
      <div className="mono" style={{ fontSize: 11 }}>{Math.round(v * 100)}%</div>
      <div className="track"><div className="fill" style={{ width: `${Math.min(1, v) * 100}%`, background: v > 0.25 ? 'var(--ok)' : 'var(--accent)' }} /></div>
    </div>
  );
}

function Kpi({ l, v, c, sub }: { l: string; v: string | number; c?: string; sub?: string }) {
  return <div className="kpi"><div className="v" style={c ? { color: c } : undefined}>{v}</div><div className="l">{l}</div>{sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}</div>;
}

function jobLine(s: Record<string, unknown>): string {
  const n = (x: unknown) => (typeof x === 'number' ? x : Array.isArray(x) ? x.length : null);
  const parts: string[] = [];
  for (const k of ['created', 'wins', 'proposals', 'clusters', 'evaluated', 'accepted', 'rejected', 'promoted', 'compressions', 'deprecated']) {
    const v = n(s[k]);
    if (v) parts.push(`${k} ${v}`);
  }
  for (const k of ['mine', 'update', 'optimize', 'evaluate']) if (s[k] && typeof s[k] === 'object') parts.push(`${k}: ${jobLine(s[k] as Record<string, unknown>) || '—'}`);
  if (typeof s.note === 'string') parts.push(s.note);
  return parts.join(' · ');
}
