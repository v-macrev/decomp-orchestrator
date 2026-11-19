// SPDX-License-Identifier: AGPL-3.0-or-later
// Credential pool management. Secrets are referenced (env:NAME / file:PATH), never entered here.
import { useCallback, useEffect, useState } from 'react';
import type { Account } from '@decomp/core';
import { api, stream, type AccountView } from '../api';
import { AccountsTable } from './Runs';

const TEMPLATE: Record<string, unknown> = {
  id: 'claude-ws-c',
  label: 'Claude · workspace C',
  provider: 'anthropic',
  workspace: 'anthropic:workspace-c',
  auth: { type: 'api_key', secretRef: 'env:ANTHROPIC_KEY_WS_C' },
  models: [{ id: 'claude-sonnet-5-5', roles: ['worker'], defaultEffort: 'medium', contextTokens: 1000000, maxOutputTokens: 64000, priceInPerMTok: 2, priceOutPerMTok: 10, priceCacheReadPerMTok: 0.1 }],
  limits: { requestsPerMinute: 200, inputTokensPerMinute: 800000, outputTokensPerMinute: 160000, maxConcurrency: 8, dailyBudgetUsd: 100 },
  tags: ['cheap'],
  priority: 0,
  enabled: true,
  options: {},
};

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [runtime, setRuntime] = useState<AccountView[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [lessons, setLessons] = useState<Array<{ id: string; source: string; text: string; weight: number }>>([]);

  const load = useCallback(() => {
    api.accounts().then(setAccounts);
    api.accountRuntime().then(setRuntime);
    api.lessons().then(setLessons);
  }, []);
  useEffect(() => {
    load();
    return stream(null, { accounts: setRuntime });
  }, [load]);

  const edit = (a: Account | null) => {
    setEditing(a?.id ?? '__new__');
    setText(JSON.stringify(a ?? TEMPLATE, null, 2));
    setMsg('');
  };
  const save = async () => {
    try {
      const obj = JSON.parse(text) as Account;
      if (/sk-[A-Za-z0-9]|AIza|ghp_/.test(text)) throw new Error('this looks like a raw secret; use secretRef "env:NAME" or "file:PATH" instead');
      await api.saveAccount(obj);
      setMsg(`saved ${obj.id}`);
      setEditing(null);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="page" style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="row"><h2 className="grow">Credential pool</h2><button className="primary" onClick={() => edit(null)}>Add account</button></div>
        <AccountsTable accounts={runtime} />
      </div>
      <div className="panel">
        <h2>Accounts &amp; workspaces</h2>
        <table>
          <thead><tr><th>ID</th><th>Provider</th><th>Auth</th><th>Models</th><th>Tags</th><th>Limits</th><th></th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.id}<div className="muted">{a.label}</div></td>
                <td>{a.provider}{a.baseUrl ? <div className="muted mono" style={{ fontSize: 11 }}>{a.baseUrl}</div> : null}</td>
                <td className="mono" style={{ fontSize: 11 }}>{a.auth.type}{'secretRef' in a.auth ? ` ${a.auth.secretRef}` : 'configDir' in a.auth ? ` ${a.auth.configDir}` : ''}</td>
                <td style={{ fontSize: 12 }}>{a.models.map((m) => <div key={m.id}>{m.id} <span className="muted">[{m.roles.join(',')}]</span></div>)}</td>
                <td>{a.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>#{t}</span>)}</td>
                <td className="muted" style={{ fontSize: 12 }}>{a.limits.requestsPerMinute} rpm · ×{a.limits.maxConcurrency}{a.limits.dailyBudgetUsd ? ` · $${a.limits.dailyBudgetUsd}/day` : ''}</td>
                <td className="row">
                  <button onClick={() => edit(a)}>Edit</button>
                  <button onClick={async () => { await api.accountAction(a.id, 'enable'); load(); }}>Reset health</button>
                  <button onClick={async () => { await api.accountAction(a.id, 'disable'); load(); }}>Disable</button>
                  <button className="danger" onClick={async () => { if (confirm(`Delete ${a.id}?`)) { await api.deleteAccount(a.id); load(); } }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editing && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              Providers: anthropic · openai · openai_compat (needs baseUrl) · claude_cli / codex_cli (auth.type "cli_profile" with an isolated configDir) · mock.
              Secrets: <span className="mono">{'{ "type": "api_key", "secretRef": "env:NAME" }'}</span> or <span className="mono">file:PATH</span>.
            </div>
            <textarea rows={22} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setEditing(null)}>Cancel</button><span className="muted">{msg}</span></div>
          </div>
        )}
        {!editing && msg && <p className="muted">{msg}</p>}
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
