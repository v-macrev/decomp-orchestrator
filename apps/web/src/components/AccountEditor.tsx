// SPDX-License-Identifier: AGPL-3.0-or-later
// Form editor for one account and its models. Secrets are referenced (env:NAME / file:PATH), never
// entered; CLI providers point at the config directory holding that login. JSON stays available.
import { useState } from 'react';
import type { Account, CapabilityTier } from '@decomp/core';

type Model = Account['models'][number];
type Provider = Account['provider'];
type Effort = NonNullable<Model['defaultEffort']>;

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'claude_cli', label: 'Claude Code login (claude_cli)' },
  { id: 'codex_cli', label: 'ChatGPT login via Codex (codex_cli)' },
  { id: 'anthropic', label: 'Anthropic API (anthropic)' },
  { id: 'openai', label: 'OpenAI API (openai)' },
  { id: 'openai_compat', label: 'OpenAI-compatible endpoint (openai_compat)' },
  { id: 'mock', label: 'Simulator (mock)' },
];
const CLI = (p: Provider) => p === 'claude_cli' || p === 'codex_cli';
const TIERS: CapabilityTier[] = ['fast', 'balanced', 'frontier'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ROLES = [['worker', 'Worker'], ['gatekeeper', 'Gate Keeper'], ['orchestrator', 'Orchestrator']] as const;

const base = (m: Partial<Model> & { id: string }): Model => ({
  contextTokens: 200_000, maxOutputTokens: 32_000, priceInPerMTok: 0, priceOutPerMTok: 0, priceCacheReadPerMTok: 0, roles: ['worker'], ...m,
});
/** Known models per provider: picking one fills its tier, effort, limits and list prices. */
const PRESETS: Partial<Record<Provider, Model[]>> = {
  claude_cli: [
    base({ id: 'claude-haiku-5-5', capability: 'fast', costWeight: 1, defaultEffort: 'medium', contextTokens: 1_000_000, priceInPerMTok: 0.1, priceOutPerMTok: 0.5, priceCacheReadPerMTok: 0.01, priceCacheWritePerMTok: 0.125, roles: ['worker', 'orchestrator'] }),
    base({ id: 'claude-sonnet-5-5', capability: 'balanced', costWeight: 4, defaultEffort: 'medium', contextTokens: 1_000_000, priceInPerMTok: 2, priceOutPerMTok: 10, priceCacheReadPerMTok: 0.2, priceCacheWritePerMTok: 2.5 }),
    base({ id: 'claude-opus-5-5', capability: 'frontier', costWeight: 10, defaultEffort: 'high', contextTokens: 1_000_000, priceInPerMTok: 4, priceOutPerMTok: 20, priceCacheReadPerMTok: 0.4, priceCacheWritePerMTok: 5, roles: ['worker', 'gatekeeper', 'orchestrator'] }),
  ],
  codex_cli: [
    base({ id: 'gpt-6-luna', capability: 'fast', costWeight: 1, defaultEffort: 'medium', contextTokens: 272_000 }),
    base({ id: 'gpt-5.6-terra', capability: 'balanced', costWeight: 4, defaultEffort: 'medium', contextTokens: 272_000 }),
  ],
};
PRESETS.anthropic = PRESETS.claude_cli;

export function blankAccount(provider: Provider = 'claude_cli'): Account {
  return {
    id: '', label: '', provider, auth: CLI(provider) ? { type: 'cli_profile', configDir: '' } : provider === 'mock' ? { type: 'none' } : { type: 'api_key', secretRef: 'env:' },
    models: (PRESETS[provider] ?? [base({ id: '' })]).map((m) => ({ ...m, roles: [...m.roles] })),
    limits: { requestsPerMinute: 12, inputTokensPerMinute: 400_000, outputTokensPerMinute: 80_000, maxConcurrency: 2 },
    tags: [], priority: 1, enabled: true, options: {},
  };
}

/** A copy for another login of the same kind (e.g. a second workspace): new id, empty login dir. */
export function duplicateAccount(a: Account, taken: string[]): Account {
  let n = 2;
  const stem = a.id.replace(/-\d+$/, '');
  while (taken.includes(`${stem}-${n}`)) n++;
  const auth = a.auth.type === 'cli_profile' ? { ...a.auth, configDir: '' } : a.auth;
  return { ...structuredClone(a), id: `${stem}-${n}`, label: `${a.label} (copy)`, auth };
}

const num = (v: string) => (v === '' ? undefined : Number(v));

export function AccountEditor({ initial, isNew, taken, onSave, onCancel }: {
  initial: Account;
  isNew: boolean;
  taken: string[];
  onSave: (a: Account) => Promise<void>;
  onCancel: () => void;
}) {
  const [a, setA] = useState<Account>(initial);
  const [json, setJson] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const set = (p: Partial<Account>) => setA((x) => ({ ...x, ...p }));
  const setModel = (i: number, p: Partial<Model>) => set({ models: a.models.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const presets = PRESETS[a.provider] ?? [];

  const setProvider = (provider: Provider) => {
    const auth: Account['auth'] = CLI(provider)
      ? { type: 'cli_profile', configDir: a.auth.type === 'cli_profile' ? a.auth.configDir : '' }
      : provider === 'mock' ? { type: 'none' }
        : a.auth.type === 'api_key' || a.auth.type === 'oauth_token' ? a.auth : { type: 'api_key', secretRef: 'env:' };
    set({ provider, auth, ...(isNew ? { models: (PRESETS[provider] ?? [base({ id: '' })]).map((m) => ({ ...m, roles: [...m.roles] })) } : {}) });
  };
  const pickModelId = (i: number, id: string) => {
    const p = presets.find((x) => x.id === id);
    const cur = a.models[i]!;
    // A known id fills the rest only while the row is still blank (prices untouched).
    if (p && !cur.priceInPerMTok && !cur.priceOutPerMTok) setModel(i, { ...p, roles: [...p.roles] });
    else setModel(i, { id });
  };

  const problems = (x: Account): string[] => {
    const out: string[] = [];
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(x.id)) out.push('id: lowercase letters, digits, - and _ only');
    if (isNew && taken.includes(x.id)) out.push(`id ${x.id} is already used`);
    if (!x.label.trim()) out.push('label is required');
    if (x.auth.type === 'cli_profile' && !x.auth.configDir.trim()) out.push('login directory is required');
    if ((x.auth.type === 'api_key' || x.auth.type === 'oauth_token') && !/^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/.test(x.auth.secretRef)) out.push('secret reference must be env:NAME or file:PATH');
    if (x.provider === 'openai_compat' && !x.baseUrl) out.push('an OpenAI-compatible endpoint needs a base URL');
    if (!x.models.length) out.push('add at least one model');
    if (x.models.some((m) => !m.id.trim())) out.push('every model needs an id');
    if (/sk-[A-Za-z0-9]|AIza|ghp_/.test(JSON.stringify(x))) out.push('this looks like a raw secret; use env:NAME or file:PATH instead');
    return out;
  };

  const save = async () => {
    let x = a;
    try {
      if (json !== null) x = JSON.parse(json) as Account;
    } catch (e) {
      return setMsg(`JSON: ${(e as Error).message}`);
    }
    const p = problems(x);
    if (p.length) return setMsg(p.join(' · '));
    try {
      await onSave(x);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="panel editor" style={{ display: 'grid', gap: 10 }}>
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>{isNew ? 'New account' : `Edit ${initial.id}`}</h2>
        <button onClick={() => (json === null ? setJson(JSON.stringify(a, null, 2)) : (() => { try { setA(JSON.parse(json) as Account); setJson(null); } catch (e) { setMsg(`JSON: ${(e as Error).message}`); } })())}>
          {json === null ? 'Edit as JSON' : 'Back to form'}
        </button>
      </div>

      {json !== null ? (
        <textarea rows={24} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      ) : (
        <>
          <div className="form-grid">
            <label>Provider
              <select value={a.provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label>ID<input value={a.id} disabled={!isNew} placeholder="claude-cli-ws3" onChange={(e) => set({ id: e.target.value.trim() })} /></label>
            <label>Label<input value={a.label} placeholder="Claude Code · workspace 3" onChange={(e) => set({ label: e.target.value })} /></label>
            {a.auth.type === 'cli_profile' && (
              <label className="wide">Login directory ({a.provider === 'claude_cli' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'})
                <input className="mono" value={a.auth.configDir} placeholder={a.provider === 'claude_cli' ? 'C:/Users/you/.claude-workspace3' : 'C:/Users/you/.codex'} onChange={(e) => set({ auth: { type: 'cli_profile', configDir: e.target.value, ...(a.auth.type === 'cli_profile' && a.auth.binary ? { binary: a.auth.binary } : {}) } })} />
                <span className="muted hint">
                  {a.provider === 'claude_cli'
                    ? <>Sign in once: <span className="mono">$env:CLAUDE_CONFIG_DIR = '&lt;dir&gt;'; claude auth login</span> (pick the workspace in the browser).</>
                    : <>The folder holding the Codex login (<span className="mono">codex login status</span>).</>}
                </span>
              </label>
            )}
            {(a.auth.type === 'api_key' || a.auth.type === 'oauth_token') && (
              <>
                <label>Auth
                  <select value={a.auth.type} onChange={(e) => set({ auth: { type: e.target.value as 'api_key' | 'oauth_token', secretRef: 'secretRef' in a.auth ? a.auth.secretRef : 'env:' } })}>
                    <option value="api_key">API key</option>
                    <option value="oauth_token">OAuth token</option>
                  </select>
                </label>
                <label>Secret reference
                  <input className="mono" value={a.auth.secretRef} placeholder="env:ANTHROPIC_KEY_WS_C or file:C:/secrets/key" onChange={(e) => set({ auth: { type: (a.auth as { type: 'api_key' | 'oauth_token' }).type, secretRef: e.target.value } })} />
                  <span className="muted hint">Where the secret lives, never the secret itself.</span>
                </label>
              </>
            )}
            {(a.provider === 'openai_compat' || a.provider === 'openai' || a.provider === 'anthropic') && (
              <label>Base URL<input className="mono" value={a.baseUrl ?? ''} placeholder={a.provider === 'openai_compat' ? 'http://localhost:11434/v1' : 'default'} onChange={(e) => set({ baseUrl: e.target.value || undefined })} /></label>
            )}
            <label>Tags<input value={a.tags.join(' ')} placeholder="cheap strong orchestrator" onChange={(e) => set({ tags: e.target.value.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean) })} /><span className="muted hint">Flow nodes can require tags (the default Orchestrator takes #orchestrator).</span></label>
            <label>Priority<input type="number" value={a.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} /><span className="muted hint">Higher wins when several accounts can serve.</span></label>
            <label className="inline"><input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
          </div>

          <h3 style={{ margin: '6px 0 0' }}>Limits</h3>
          <div className="form-grid">
            <label>Requests / min<input type="number" min={1} value={a.limits.requestsPerMinute} onChange={(e) => set({ limits: { ...a.limits, requestsPerMinute: Number(e.target.value) || 1 } })} /></label>
            <label>Parallel calls<input type="number" min={1} value={a.limits.maxConcurrency} onChange={(e) => set({ limits: { ...a.limits, maxConcurrency: Number(e.target.value) || 1 } })} /></label>
            <label>Input tokens / min<input type="number" min={1} value={a.limits.inputTokensPerMinute} onChange={(e) => set({ limits: { ...a.limits, inputTokensPerMinute: Number(e.target.value) || 1 } })} /></label>
            <label>Output tokens / min<input type="number" min={1} value={a.limits.outputTokensPerMinute} onChange={(e) => set({ limits: { ...a.limits, outputTokensPerMinute: Number(e.target.value) || 1 } })} /></label>
            <label>Daily budget USD<input type="number" min={0} value={a.limits.dailyBudgetUsd ?? ''} placeholder="none" onChange={(e) => set({ limits: { ...a.limits, dailyBudgetUsd: num(e.target.value) || undefined } })} /></label>
          </div>

          <div className="row" style={{ marginTop: 6 }}>
            <h3 className="grow" style={{ margin: 0 }}>Models</h3>
            <button onClick={() => set({ models: [...a.models, base({ id: '' })] })}>Add model</button>
          </div>
          <datalist id={`presets-${a.provider}`}>{presets.map((p) => <option key={p.id} value={p.id} />)}</datalist>
          <div style={{ overflowX: 'auto' }}>
            <table className="models">
              <thead>
                <tr>
                  <th>Model</th><th>Tier</th><th>Roles</th><th>Effort</th><th>Context</th>
                  <th title="USD per million tokens: input / output / cache read / cache write">Price in · out · cache r · w ($/MTok)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {a.models.map((m, i) => (
                  <tr key={i}>
                    <td><input className="mono" list={`presets-${a.provider}`} value={m.id} placeholder="model id" onChange={(e) => pickModelId(i, e.target.value)} style={{ width: 170 }} /></td>
                    <td>
                      <select value={m.capability ?? ''} onChange={(e) => setModel(i, { capability: (e.target.value || undefined) as CapabilityTier | undefined })}>
                        <option value="">none</option>
                        {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {ROLES.map(([r, l]) => (
                        <label key={r} className="inline" style={{ marginRight: 8 }}>
                          <input type="checkbox" checked={m.roles.includes(r)} onChange={(e) => setModel(i, { roles: e.target.checked ? [...m.roles, r] : m.roles.filter((x) => x !== r) })} />{l}
                        </label>
                      ))}
                    </td>
                    <td>
                      <select value={m.defaultEffort ?? ''} onChange={(e) => setModel(i, { defaultEffort: (e.target.value || undefined) as Effort | undefined })}>
                        <option value="">default</option>
                        {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </td>
                    <td><input type="number" min={1000} step={1000} value={m.contextTokens} onChange={(e) => setModel(i, { contextTokens: Number(e.target.value) || 200_000 })} style={{ width: 95 }} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {(['priceInPerMTok', 'priceOutPerMTok', 'priceCacheReadPerMTok'] as const).map((k) => (
                        <input key={k} type="number" min={0} step="any" value={m[k]} onChange={(e) => setModel(i, { [k]: Number(e.target.value) || 0 })} style={{ width: 62, marginRight: 4 }} />
                      ))}
                      <input type="number" min={0} step="any" value={m.priceCacheWritePerMTok ?? ''} placeholder="=in" onChange={(e) => setModel(i, { priceCacheWritePerMTok: num(e.target.value) })} style={{ width: 62 }} />
                    </td>
                    <td><button className="danger tiny" onClick={() => set({ models: a.models.filter((_, j) => j !== i) })} title="Remove model">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            Tier decides which worker node uses the model (fast → easy functions, balanced → medium, frontier → hard). Roles decide whether it can also act as
            Orchestrator or Gate Keeper. The Model assignment grid shows the same choices per flow node. Leave prices at 0 for a subscription with no list price; it then never counts toward a run budget.
          </p>
        </>
      )}
      <div className="row">
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onCancel}>Cancel</button>
        <span className="lvl-error" style={{ fontSize: 12 }}>{msg}</span>
      </div>
    </div>
  );
}
