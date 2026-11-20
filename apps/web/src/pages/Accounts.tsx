// SPDX-License-Identifier: AGPL-3.0-or-later
// Credential pool management. Secrets are referenced (env:NAME / file:PATH), never entered here.
// Accounts are edited in a form; which model serves which flow node is set in the assignment grid.
import { useCallback, useEffect, useState } from 'react';
import type { Account, Flow } from '@decomp/core';
import { api, stream, type AccountView, type SubscriptionUsage } from '../api';
import { AccountEditor, blankAccount, duplicateAccount } from '../components/AccountEditor';
import { ConfirmButton } from '../components/ConfirmButton';
import { ModelAssignment } from '../components/ModelAssignment';
import { AccountsTable } from './Runs';

function windowLabel(minutes?: number | null) {
  if (!minutes) return 'Usage window';
  if (minutes === 10_080) return 'Weekly';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function CodexSubscription({ accountId }: { accountId: string }) {
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    setUsage(null);
    try {
      setUsage(await api.subscriptionUsage(accountId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const buckets = usage?.buckets.filter((bucket) => bucket.windows.length > 0);

  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={refresh} disabled={loading}>
        {loading ? 'Reading usage…' : usage ? 'Refresh subscription usage' : 'Check subscription usage'}
      </button>
      <div role="status">
        {error && <div className="lvl-error">{error}</div>}
        {buckets?.length === 0 && <div>Codex returned no subscription windows.</div>}
        {buckets?.map((bucket) => (
          <div key={bucket.id} style={{ marginTop: 6 }}>
            <strong>{bucket.label}{bucket.plan ? ` · ${bucket.plan}` : ''}</strong>
            {bucket.windows.map((window, index) => (
              <div key={index}>
                {windowLabel(window.windowDurationMins)} · {window.usedPercent}% used
                {window.resetsAt ? ` · resets ${new Date(window.resetsAt * 1_000).toLocaleString()}` : ''}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [drafts, setDrafts] = useState<Account[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runtime, setRuntime] = useState<AccountView[]>([]);
  const [editing, setEditing] = useState<{ account: Account; isNew: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [lessons, setLessons] = useState<Array<{ id: string; source: string; text: string; weight: number }>>([]);

  const load = useCallback(() => {
    api.accounts().then((a) => { setAccounts(a); setDrafts(a); });
    api.accountRuntime().then(setRuntime);
    api.flows().then(setFlows);
    api.lessons().then(setLessons);
  }, []);
  useEffect(() => {
    load();
    return stream(null, { accounts: setRuntime });
  }, [load]);

  const saved = new Map(accounts.map((a) => [a.id, JSON.stringify(a)]));
  const dirty = new Set(drafts.filter((d) => saved.get(d.id) !== JSON.stringify(d)).map((d) => d.id));

  const saveDrafts = async () => {
    setSaving(true);
    try {
      for (const d of drafts.filter((x) => dirty.has(x.id))) await api.saveAccount(d);
      setMsg(`saved ${[...dirty].join(', ')}`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveOne = async (a: Account) => {
    await api.saveAccount(a);
    setMsg(`saved ${a.id}`);
    setEditing(null);
    load();
  };
  const startEdit = (account: Account, isNew: boolean) => {
    if (dirty.size && !confirm('Discard the unsaved model assignment changes?')) return;
    setDrafts(accounts);
    setEditing({ account: structuredClone(account), isNew });
    setMsg('');
  };

  return (
    <div className="page" style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="row"><h2 className="grow">Credential pool</h2><button className="primary" onClick={() => startEdit(blankAccount(), true)}>Add account</button></div>
        <AccountsTable accounts={runtime} />
      </div>

      {editing && (
        <AccountEditor
          key={editing.account.id || '__new__'}
          initial={editing.account}
          isNew={editing.isNew}
          taken={accounts.map((a) => a.id)}
          accounts={accounts}
          onSave={saveOne}
          onCancel={() => setEditing(null)}
        />
      )}

      {!editing && (
        <ModelAssignment
          drafts={drafts}
          runtime={runtime}
          flows={flows}
          dirty={dirty}
          saving={saving}
          onChange={(a) => setDrafts((ds) => ds.map((d) => (d.id === a.id ? a : d)))}
          onSave={saveDrafts}
          onDiscard={() => setDrafts(accounts)}
        />
      )}

      <div className="panel">
        <h2>Accounts &amp; workspaces</h2>
        <table>
          <thead><tr><th>ID</th><th>Provider</th><th>Login / secret</th><th>Models</th><th>Tags</th><th>Limits</th><th></th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.id}<div className="muted">{a.label}</div></td>
                <td>{a.provider}{a.baseUrl ? <div className="muted mono" style={{ fontSize: 11 }}>{a.baseUrl}</div> : null}</td>
                <td className="mono" style={{ fontSize: 11 }}>{a.auth.type}{'secretRef' in a.auth ? ` ${a.auth.secretRef}` : 'configDir' in a.auth ? ` ${a.auth.configDir}` : ''}</td>
                <td style={{ fontSize: 12 }}>
                  {a.models.map((m) => (
                    <div key={m.id}>{m.id} {m.capability && <span className={`cap ${m.capability}`}>{m.capability}</span>} <span className="muted">{m.roles.join(', ')}</span></div>
                  ))}
                </td>
                <td>{a.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>#{t}</span>)}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {a.limits.requestsPerMinute} rpm · ×{a.limits.maxConcurrency}{a.limits.dailyBudgetUsd ? ` · $${a.limits.dailyBudgetUsd}/day` : ''}
                  {a.provider === 'codex_cli' && a.auth.type === 'cli_profile' && (
                    <CodexSubscription key={`${a.auth.configDir}:${a.auth.binary ?? ''}`} accountId={a.id} />
                  )}
                </td>
                <td className="row">
                  <button onClick={() => startEdit(a, false)}>Edit</button>
                  <button onClick={() => startEdit(duplicateAccount(a, accounts.map((x) => x.id)), true)} title="Copy this account for another login of the same kind, e.g. another workspace">Duplicate</button>
                  <button onClick={async () => { await api.accountAction(a.id, 'enable'); load(); }}>Reset health</button>
                  <button onClick={async () => { await api.accountAction(a.id, 'disable'); load(); }}>Disable</button>
                  <ConfirmButton onConfirm={async () => { await api.deleteAccount(a.id); load(); }} confirmLabel={`Delete ${a.id}?`}>Delete</ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {msg && <p className="muted">{msg}</p>}
      </div>

      <div className="panel">
        <div className="row">
          <h2 className="grow">Lessons fed to workers</h2>
          <button onClick={async () => setMsg(JSON.stringify(await api.refreshLessons(false)))}>Reload repo lessons</button>
          <button onClick={async () => { setMsg(JSON.stringify(await api.refreshLessons(true))); load(); }} title="Uses your gh login to read the project bot's PR comments">Ingest PR history (gh)</button>
        </div>
        <table><tbody>{lessons.map((l) => <tr key={l.id}><td><span className="chip">{l.source}</span></td><td>{l.text}</td><td className="muted">{l.weight.toFixed(1)}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
