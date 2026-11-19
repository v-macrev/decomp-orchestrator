// SPDX-License-Identifier: AGPL-3.0-or-later
// Which model does what: every account's models against the nodes of a flow. Ticking a worker
// column sets the model's tier (one tier per model); ticking Orchestrator / Gate Keeper toggles that
// role. Each cell shows whether the scheduler really uses the pair, resolved by the server against
// the unsaved drafts, so the grid can never drift from what the engine does.
import { useEffect, useState } from 'react';
import type { Account, CapabilityTier, Flow, ModelSpec } from '@decomp/core';
import { api, type AccountView, type FlowAssignments, type NodeAssignment } from '../api';

type Model = Account['models'][number];

const ROLE_ORDER = { orchestrator: 0, worker: 1, gatekeeper: 2 } as const;
const TIER_ORDER: Record<CapabilityTier, number> = { fast: 0, balanced: 1, frontier: 2 };

/** Whether this model is assigned to the node (what the checkbox shows). */
export function assigned(m: Model, n: NodeAssignment): boolean {
  if (n.binding.model) return m.id === n.binding.model;
  if (n.role === 'worker') return m.roles.includes('worker') && (n.capability ? m.capability === n.capability : true);
  return m.roles.includes(n.role);
}

/** The model after (un)assigning it to the node; a worker model serves one tier. */
export function toggle(m: Model, n: NodeAssignment, on: boolean): Model {
  const roles = new Set(m.roles);
  if (n.role === 'worker') {
    if (on) {
      roles.add('worker');
      return { ...m, roles: [...roles], capability: n.capability ?? m.capability };
    }
    roles.delete('worker');
    return { ...m, roles: [...roles], capability: undefined };
  }
  if (on) roles.add(n.role);
  else roles.delete(n.role);
  return { ...m, roles: [...roles] };
}

export function ModelAssignment({ drafts, runtime, flows, dirty, onChange, onSave, onDiscard, saving }: {
  drafts: Account[];
  runtime: AccountView[];
  flows: Flow[];
  dirty: Set<string>;
  onChange: (a: Account) => void;
  onSave: () => void;
  onDiscard: () => void;
  saving: boolean;
}) {
  const [flowId, setFlowId] = useState('default');
  const [res, setRes] = useState<FlowAssignments | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!flows.length) return;
    const id = flows.some((f) => f.id === flowId) ? flowId : flows[0]!.id;
    if (id !== flowId) setFlowId(id);
    const t = setTimeout(() => {
      api.flowAssignments(id, drafts).then((r) => { setRes(r); setErr(''); }, (e: Error) => setErr(e.message));
    }, 150);
    return () => clearTimeout(t);
  }, [drafts, flowId, flows]);

  const nodes = [...(res?.nodes ?? [])].sort((a, b) =>
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (TIER_ORDER[a.capability ?? 'fast'] - TIER_ORDER[b.capability ?? 'fast']));
  const status = new Map(runtime.map((r) => [r.accountId, r.status]));

  const setModel = (a: Account, i: number, m: Model, extraTags: string[] = []) => {
    const models = a.models.map((x, j) => (j === i ? m : x));
    const tags = [...new Set([...a.tags, ...extraTags])];
    onChange({ ...a, models, tags });
  };
  const moveUp = (a: Account, i: number) => {
    if (i === 0) return;
    const models = [...a.models];
    [models[i - 1], models[i]] = [models[i]!, models[i - 1]!];
    onChange({ ...a, models });
  };

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 className="grow" style={{ margin: 0 }}>Model assignment</h2>
        <label className="inline">Flow
          <select value={flowId} onChange={(e) => setFlowId(e.target.value)}>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
          </select>
        </label>
        <button className="primary" disabled={!dirty.size || saving} onClick={onSave}>{saving ? 'Saving…' : `Save changes${dirty.size ? ` (${dirty.size})` : ''}`}</button>
        <button disabled={!dirty.size || saving} onClick={onDiscard}>Discard</button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        Tick which models serve each node. A worker model serves one tier, so ticking another tier column moves it.
        Each account sends one model per node: the first ticked one in its list (use ↑ to reorder).
        <span className="dot on" /> in use · <span className="dot off" /> ticked but not used (hover for why) · <span className="dot fb" /> serving as a fallback.
      </p>
      {err && <div className="lvl-error">{err}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="assign">
          <thead>
            <tr>
              <th>Account · model</th>
              {nodes.map((n) => (
                <th key={n.nodeId} title={nodeTitle(n)} className={n.usesModel ? '' : 'muted'}>
                  <div>{n.label}</div>
                  <div style={{ fontWeight: 400, fontSize: 11 }}>
                    {n.capability && <span className={`cap ${n.capability}`}>{n.capability}</span>} ×{n.instances}
                    {n.binding.tags.length > 0 && <span className="muted"> {n.binding.tags.map((t) => `#${t}`).join(' ')}</span>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {drafts.map((a) => (
              <AccountRows key={a.id} a={a} nodes={nodes} status={status.get(a.id)} dirty={dirty.has(a.id)} setModel={setModel} moveUp={moveUp} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="muted">Served by</td>
              {nodes.map((n) => (
                <td key={n.nodeId} style={{ fontSize: 12 }}>
                  {!n.usesModel ? <span className="muted">no model needed</span>
                    : n.serves.length === 0 ? <span className="lvl-error">nothing: the node cannot run</span>
                      : <span className={n.fallback ? 'lvl-warn' : ''}>{n.serves.length} account{n.serves.length === 1 ? '' : 's'}{n.fallback ? ' (fallback)' : ''}</span>}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function nodeTitle(n: NodeAssignment): string {
  const parts = [`${n.label}: ${n.role}${n.capability ? `, ${n.capability} tier` : ''}, ${n.instances} instance(s)`];
  if (!n.usesModel) parts.push('LLM review is off for this Gate Keeper: it runs deterministic checks only and calls no model.');
  if (n.binding.model) parts.push(`Pinned to model ${n.binding.model} in the Flow builder.`);
  if (n.binding.strategy === 'bound') parts.push(`Bound to accounts: ${n.binding.accountIds.join(', ') || 'none'}.`);
  if (n.binding.tags.length) parts.push(`Only takes accounts tagged ${n.binding.tags.map((t) => `#${t}`).join(' ')}.`);
  if (n.fallback) parts.push(`No model declares the ${n.capability} tier, so every worker model serves it.`);
  return parts.join('\n');
}

function AccountRows({ a, nodes, status, dirty, setModel, moveUp }: {
  a: Account;
  nodes: NodeAssignment[];
  status: string | undefined;
  dirty: boolean;
  setModel: (a: Account, i: number, m: Model, extraTags?: string[]) => void;
  moveUp: (a: Account, i: number) => void;
}) {
  return (
    <>
      <tr className="acct">
        <td colSpan={nodes.length + 1}>
          <b>{a.label}</b> <span className="muted mono">{a.id} · {a.provider}</span>{' '}
          {!a.enabled ? <span className="chip disabled">disabled</span> : status && <span className={`chip ${status}`}>{status}</span>}
          {dirty && <span className="chip warn" style={{ marginLeft: 4 }}>unsaved</span>}
        </td>
      </tr>
      {a.models.map((m, i) => (
        <tr key={m.id + i}>
          <td className="mono" style={{ whiteSpace: 'nowrap' }}>
            <button className="tiny" disabled={i === 0} onClick={() => moveUp(a, i)} title="Move up: earlier models win when several match a node">↑</button>{' '}
            {m.id}
          </td>
          {nodes.map((n) => <Cell key={n.nodeId} a={a} i={i} m={m} n={n} setModel={setModel} />)}
        </tr>
      ))}
    </>
  );
}

function Cell({ a, i, m, n, setModel }: { a: Account; i: number; m: ModelSpec; n: NodeAssignment; setModel: (a: Account, i: number, m: Model, extraTags?: string[]) => void }) {
  if (!n.usesModel) return <td className="muted">—</td>;
  const on = assigned(m, n);
  const ex = n.excluded.find((e) => e.accountId === a.id);
  const used = n.serves.some((s) => s.accountId === a.id && s.modelId === m.id);
  const pinned = !!n.binding.model;
  const bound = ex && n.binding.strategy === 'bound';
  const missingTags = ex && !bound ? n.binding.tags.filter((t) => !a.tags.includes(t)) : [];
  let why = '';
  if (on && !used) {
    const other = n.serves.find((s) => s.accountId === a.id);
    why = !a.enabled ? 'account is disabled'
      : ex ? ex.reason
        : other ? `this account sends ${other.modelId} to this node (it comes first in the list)`
          : 'not used';
  }
  const title = pinned ? `node is pinned to ${n.binding.model} in the Flow builder`
    : bound ? 'node is bound to specific accounts; change that in the Flow builder'
      : missingTags.length && !on ? `ticking also tags this account ${missingTags.map((t) => `#${t}`).join(' ')}`
        : why || (used ? 'in use' : '');
  return (
    <td title={title} style={{ whiteSpace: 'nowrap' }}>
      <input
        type="checkbox"
        checked={on}
        disabled={pinned || !!bound}
        onChange={(e) => setModel(a, i, toggle(m, n, e.target.checked), e.target.checked ? missingTags : [])}
      />{' '}
      {used && on && <span className="dot on" />}
      {used && !on && <span className="dot fb" />}
      {on && !used && <span className="dot off" />}
    </td>
  );
}
