// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { TaskContextBundle } from '@decomp/core';
import { api, type TaskDetail } from '../api';
import { DifficultyBadge } from '../pages/Runs';
import { Diff } from './Diff';

/** What a worker was shown for one attempt: per-section tokens vs. budget and raw source size. */
function BundleInspector({ hash }: { hash: string }) {
  const [b, setB] = useState<TaskContextBundle | null>(null);
  const [legacy, setLegacy] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.bundle(hash).then((x) => {
      if ('version' in x && x.version === 2) setB(x);
      else setLegacy((x as { approxTokens: number }).approxTokens);
    }).catch(() => undefined);
  }, [hash]);
  if (legacy !== null) return <p className="muted">Legacy bundle · ~{legacy} tokens (no per-section budgets).</p>;
  if (!b) return null;
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        {b.tokens.sent} tokens sent of {b.tokens.raw} in the unsliced sources ({b.tokens.raw ? Math.round((1 - b.tokens.sent / b.tokens.raw) * 100) : 0}% trimmed) ·
        static prefix {b.tokens.staticPrefix} · cacheable packet block {b.tokens.taskPrefix} · output mode <b>{b.outputMode}</b>
        {b.elidedFunctions.length ? ` · ${b.elidedFunctions.length} accepted bodies elided` : ''} · patterns: {b.patterns.join(', ') || '—'}
      </p>
      <table>
        <thead><tr><th>Section</th><th>Tokens</th><th>Budget</th><th>Raw</th><th /></tr></thead>
        <tbody>
          {b.sections.map((s) => (
            <tr key={s.kind} className="click" onClick={() => setOpen(open === s.kind ? null : s.kind)}>
              <td className="mono">{s.kind}{s.privacy === 'private' ? <span className="chip warn" style={{ marginLeft: 6 }}>private</span> : null}{s.truncated ? <span className="chip" style={{ marginLeft: 6 }}>trimmed</span> : null}</td>
              <td>{s.tokens}</td><td className="muted">{s.budgetTokens}</td><td className="muted">{s.rawTokens}</td>
              <td className="muted">{open === s.kind ? '▾' : '▸'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: 11 }}>{b.sections.find((s) => s.kind === open)?.content}</pre>}
    </>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [d, setD] = useState<TaskDetail | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.task(taskId).then((x) => {
      setD(x);
      setSel(x.attempts.at(-1)?.id ?? null);
    }).catch((e) => setErr(String(e)));
  }, [taskId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  if (!d) return <div className="drawer">{err || 'loading…'}</div>;
  const attempt = d.attempts.find((a) => a.id === sel);
  const verdict = d.verdicts.find((v) => v.attemptId === sel);
  const t = d.task;
  return (
    <div className="drawer" role="dialog" aria-label="Task detail">
      <div className="row">
        <h2 className="grow mono">{t.unit}</h2>
        {['dead', 'quarantined', 'cancelled'].includes(t.state) && <button onClick={async () => { await api.requeue(t.id, 0); setD(await api.task(t.id)); }}>Requeue at tier 0</button>}
        <button onClick={onClose}>Close</button>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`chip ${t.state}`}>{t.state}</span>
        <DifficultyBadge d={t.difficulty} score={t.complexity} promoted={!!t.assessment && t.assessment.difficulty !== t.difficulty} />
        <span className="muted">tier {t.tier} · {t.attemptsTotal} attempts · best {t.bestExactBytes} B exact · strikes {t.cheatStrikes}</span>
      </div>
      {t.hold && (
        <div className="notice" style={{ marginBottom: 8 }}>
          <b className="lvl-warn">Held: every function matches, but the file cannot pass the repository preflight.</b>
          <div className="muted small">The preflight blocks on line(s) that were in the file before this packet, which the workers cannot change without breaking another function. Fix them in the repository, then put the packet back from the run's held-back list.</div>
          <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>{t.hold.problems.map((p, i) => <li key={i}><span className="mono">{p.file ?? '?'}:{p.line ?? '?'}</span> {p.message}</li>)}</ul>
        </div>
      )}
      {t.assessment && (
        <details style={{ marginBottom: 8 }}>
          <summary className="muted">Complexity {t.assessment.score} ({t.assessment.decidedBy}{t.assessment.borderline ? ', borderline' : ''}; features from {t.assessment.features.source.replace('_', ' ')})</summary>
          <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>{t.assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
      <table>
        <thead><tr><th>RVA</th><th>Function</th><th>Size</th></tr></thead>
        <tbody>{t.functions.map((f) => <tr key={f.rva}><td className="mono">{f.rva}</td><td>{f.name ?? '—'}</td><td>{f.size} B</td></tr>)}</tbody>
      </table>

      <h3>Attempts</h3>
      <table>
        <thead><tr><th>#</th><th>Tier</th><th>Account / model</th><th>Status</th><th>Verdict</th><th>Tokens in/out</th><th>Cached</th><th>Cost</th><th>Latency</th></tr></thead>
        <tbody>
          {d.attempts.map((a) => {
            const v = d.verdicts.find((x) => x.attemptId === a.id);
            return (
              <tr key={a.id} className="click" onClick={() => setSel(a.id)} style={a.id === sel ? { outline: '1px solid var(--accent)' } : undefined}>
                <td>{a.n}</td><td>{a.tier}</td><td className="mono">{a.accountId ?? '—'}<br /><span className="muted">{a.model}</span></td>
                <td><span className={`chip ${a.status === 'completed' ? 'ok' : a.status === 'abandoned' ? 'warn' : 'error'}`}>{a.status}</span></td>
                <td>{v ? <><span className={`chip ${v.decision}`}>{v.decision}</span> <span className={`chip ${v.route}`}>{v.route}</span></> : '—'}</td>
                <td className="mono">{a.usage.inputTokens}/{a.usage.outputTokens}{a.difficulty ? <div><span className={`diff ${a.difficulty}`}>{a.difficulty}</span></div> : null}</td>
                <td className="mono">{a.usage.inputTokens ? `${Math.round((a.usage.cacheReadTokens / a.usage.inputTokens) * 100)}%` : '—'}</td>
                <td>${a.costUsd.toFixed(4)}</td>
                <td>{a.latencyMs ? `${(a.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {attempt && (
        <>
          {attempt.error && <p className="lvl-error mono">{attempt.error}</p>}
          {attempt.bundleHash && (
            <>
              <h3>Context bundle</h3>
              <BundleInspector key={attempt.bundleHash} hash={attempt.bundleHash} />
            </>
          )}
          {verdict && (
            <>
              <h3>Gate Keeper stages</h3>
              <div className="row">
                {verdict.stages.map((s) => <span key={s.name} className={`chip ${s.skipped ? '' : s.ok ? 'ok' : 'error'}`}>{s.name}{s.skipped ? ' (skipped)' : ` ${s.ms}ms`}</span>)}
              </div>
              {verdict.compare && verdict.compare.length > 0 && (
                <>
                  <h3>Comparator</h3>
                  <table>
                    <thead><tr><th>RVA</th><th>Result</th><th>Reason</th><th>First mismatch</th><th title="Bytes identical to the target, plus relocated fields (addresses, call targets) that point at the same target and so match by reference">Bytes that agree</th><th title="Bytes that match the target after alignment: progress even when the first byte differs">Aligned</th><th>Hint</th></tr></thead>
                    <tbody>{verdict.compare.map((c) => (
                      <tr key={c.rva}><td className="mono">{c.rva}</td><td><span className={`chip ${c.result === 'pass' ? 'ok' : 'error'}`}>{c.result}</span></td><td>{c.reason ?? '—'}</td><td className="mono">{c.firstMismatch ?? '—'}</td><td title={c.referenceBytes ? `${c.exactBytes ?? 0} identical + ${c.referenceBytes} in relocated fields that match by reference` : undefined}>{c.exactBytes == null ? '?' : c.exactBytes + (c.referenceBytes ?? 0)}/{c.targetSize ?? c.totalBytes ?? '?'}{c.referenceBytes ? <span className="muted small"> ({c.referenceBytes} by reference)</span> : null}</td><td>{c.alignedBytes ?? '—'}</td><td className="muted">{c.hint ?? ''}</td></tr>
                    ))}</tbody>
                  </table>
                </>
              )}
              {verdict.findings.length > 0 && (
                <>
                  <h3>Findings</h3>
                  <table>
                    <thead><tr><th>Severity</th><th>Stage</th><th>Code</th><th>Where</th><th>Message</th></tr></thead>
                    <tbody>{verdict.findings.map((f, i) => (
                      <tr key={i}><td><span className={`chip ${f.severity}`}>{f.severity}</span></td><td>{f.stage}</td><td className="mono">{f.code}</td><td className="mono">{f.file ? `${f.file.split('/').pop()}${f.line ? `:${f.line}` : ''}` : ''}</td><td>{f.message}</td></tr>
                    ))}</tbody>
                  </table>
                </>
              )}
            </>
          )}
          {attempt.files?.map((f) => (
            <div key={f.path}>
              <h3>Diff vs base · <span className="mono">{f.path}</span></h3>
              <Diff before={d.baseFiles[f.path] ?? ''} after={f.content} />
            </div>
          ))}
        </>
      )}

      <h3>Events</h3>
      <div className="log">
        {d.events.map((e) => <div key={e.seq} className={`lvl-${e.level}`}>{new Date(e.ts).toLocaleTimeString()} {e.kind} — {e.msg}</div>)}
      </div>
    </div>
  );
}
