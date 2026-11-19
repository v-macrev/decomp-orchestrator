// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import { api, type TaskDetail } from '../api';
import { Diff } from './Diff';

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
        <span className="muted">tier {t.tier} · {t.attemptsTotal} attempts · best {t.bestExactBytes} B exact · strikes {t.cheatStrikes}</span>
      </div>
      <table>
        <thead><tr><th>RVA</th><th>Function</th><th>Size</th></tr></thead>
        <tbody>{t.functions.map((f) => <tr key={f.rva}><td className="mono">{f.rva}</td><td>{f.name ?? '—'}</td><td>{f.size} B</td></tr>)}</tbody>
      </table>

      <h3>Attempts</h3>
      <table>
        <thead><tr><th>#</th><th>Tier</th><th>Account / model</th><th>Status</th><th>Verdict</th><th>Tokens</th><th>Cost</th><th>Latency</th></tr></thead>
        <tbody>
          {d.attempts.map((a) => {
            const v = d.verdicts.find((x) => x.attemptId === a.id);
            return (
              <tr key={a.id} className="click" onClick={() => setSel(a.id)} style={a.id === sel ? { outline: '1px solid var(--accent)' } : undefined}>
                <td>{a.n}</td><td>{a.tier}</td><td className="mono">{a.accountId ?? '—'}<br /><span className="muted">{a.model}</span></td>
                <td><span className={`chip ${a.status === 'completed' ? 'ok' : a.status === 'abandoned' ? 'warn' : 'error'}`}>{a.status}</span></td>
                <td>{v ? <><span className={`chip ${v.decision}`}>{v.decision}</span> <span className={`chip ${v.route}`}>{v.route}</span></> : '—'}</td>
                <td className="mono">{a.usage.inputTokens}/{a.usage.outputTokens}</td>
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
                    <thead><tr><th>RVA</th><th>Result</th><th>Reason</th><th>First mismatch</th><th>Bytes exact</th><th>Hint</th></tr></thead>
                    <tbody>{verdict.compare.map((c) => (
                      <tr key={c.rva}><td className="mono">{c.rva}</td><td><span className={`chip ${c.result === 'pass' ? 'ok' : 'error'}`}>{c.result}</span></td><td>{c.reason ?? '—'}</td><td className="mono">{c.firstMismatch ?? '—'}</td><td>{c.exactBytes ?? '?'}/{c.targetSize ?? c.totalBytes ?? '?'}</td><td className="muted">{c.hint ?? ''}</td></tr>
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
