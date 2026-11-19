// SPDX-License-Identifier: AGPL-3.0-or-later
// Drag-and-drop hierarchy/flow builder. Nodes are role instances (Orchestrator, Worker tiers,
// Gate Keepers); edge kinds are inferred from the roles they connect, so every edge the canvas
// accepts is one the engine understands. The server validates and compiles the plan live.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, addEdge,
  useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { defaultFlow, type Account, type EdgeKind, type Flow, type FlowNode, type Role } from '@decomp/core';
import { api, type FlowIssue } from '../api';

type NodeData = FlowNode['data'] & { role: Role };
type RFNode = Node<NodeData, 'role'>;
type RFEdge = Edge<{ kind: EdgeKind }>;

const ROLE_COLOR: Record<Role, string> = { orchestrator: 'var(--orch)', worker: 'var(--worker)', gatekeeper: 'var(--gate)' };
const ROLE_LABEL: Record<Role, string> = { orchestrator: 'Orchestrator', worker: 'Worker tier', gatekeeper: 'Gate Keeper' };
const EDGE_STYLE: Record<EdgeKind, { stroke: string; dash?: string; label: string }> = {
  dispatch: { stroke: 'var(--orch)', label: 'dispatch' },
  submit: { stroke: 'var(--worker)', label: 'submit' },
  reject_retry: { stroke: 'var(--bad)', dash: '6 4', label: 'reject → retry' },
  escalate: { stroke: 'var(--warn)', dash: '2 4', label: 'escalate' },
  report: { stroke: 'var(--muted)', dash: '2 3', label: 'report' },
};

function inferKind(s: Role, t: Role): EdgeKind | null {
  if (s === 'orchestrator' && t === 'worker') return 'dispatch';
  if (s === 'worker' && t === 'gatekeeper') return 'submit';
  if (s === 'gatekeeper' && t === 'worker') return 'reject_retry';
  if (s === 'worker' && t === 'worker') return 'escalate';
  if (s === 'gatekeeper' && t === 'orchestrator') return 'report';
  return null;
}

function RoleNode({ data, selected }: NodeProps<RFNode>) {
  const pool = data.pool;
  const binding = pool.strategy === 'bound' ? `bound: ${pool.accountIds.join(', ') || '—'}` : `pool${pool.tags.length ? `: #${pool.tags.join(' #')}` : ': any'}`;
  return (
    <div className={`flow-node${selected ? ' selected' : ''}`} style={{ ['--c' as string]: ROLE_COLOR[data.role] }}>
      <Handle type="target" position={Position.Left} />
      <Handle type="target" position={Position.Top} id="loop-in" />
      <div className="role">{ROLE_LABEL[data.role]}</div>
      <div className="title">{data.label || '(unnamed)'}</div>
      <div className="meta">
        {data.role !== 'orchestrator' && <>× {data.instances} · </>}
        {binding}
        {pool.model ? ` · ${pool.model}` : ''}
      </div>
      {data.role === 'worker' && <div className="meta">≤{data.maxAttempts} attempts · stuck after {data.stuckAfter}</div>}
      {data.role === 'gatekeeper' && (
        <div className="meta">{Object.entries(data.gate).filter(([, v]) => v).map(([k]) => k).join(' · ')}</div>
      )}
      <Handle type="source" position={Position.Right} />
      <Handle type="source" position={Position.Bottom} id="loop" />
    </div>
  );
}
const nodeTypes = { role: RoleNode };

function toRF(flow: Flow): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: flow.nodes.map((n) => ({ id: n.id, type: 'role', position: n.position, data: { ...n.data, role: n.type } })),
    edges: flow.edges.map((e) => styledEdge({ id: e.id, source: e.source, target: e.target, data: { kind: e.kind } })),
  };
}

function styledEdge(e: RFEdge): RFEdge {
  const kind = e.data!.kind;
  const s = EDGE_STYLE[kind];
  const loop = kind === 'reject_retry' || kind === 'escalate' || kind === 'report';
  return {
    ...e,
    label: s.label,
    animated: kind === 'dispatch',
    sourceHandle: loop ? 'loop' : null,
    targetHandle: loop ? 'loop-in' : null,
    style: { stroke: s.stroke, strokeWidth: 1.8, strokeDasharray: s.dash },
    labelStyle: { fill: s.stroke, fontSize: 11 },
    labelBgStyle: { fill: 'var(--panel)' },
    markerEnd: { type: MarkerType.ArrowClosed, color: s.stroke },
  };
}

function fromRF(base: Pick<Flow, 'id' | 'name'>, nodes: RFNode[], edges: RFEdge[]): Flow {
  return {
    id: base.id,
    name: base.name,
    nodes: nodes.map(({ id, position, data }) => {
      const { role, ...rest } = data;
      return { id, type: role, position: { x: Math.round(position.x), y: Math.round(position.y) }, data: rest };
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.data!.kind })),
  };
}

function newNode(role: Role, position: { x: number; y: number }): RFNode {
  const id = `${role}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id, type: 'role', position,
    data: {
      role, label: ROLE_LABEL[role], instances: role === 'worker' ? 4 : 1,
      pool: { strategy: 'pool', accountIds: [], tags: [] }, maxAttempts: 6, stuckAfter: 3,
      gate: { scope: true, leak: true, cheat: true, integrity: true, repoCompare: true, repoPreflight: true, llmReview: false },
    },
  };
}

function Builder() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [meta, setMeta] = useState<{ id: string; name: string }>({ id: 'default', name: 'Default' });
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selected, setSelected] = useState<{ node?: string; edge?: string }>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [issues, setIssues] = useState<FlowIssue[]>([]);
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.validateFlow>>['plan']>(null);
  const [repoSlots, setRepoSlots] = useState(0);
  const [status, setStatus] = useState('');
  const wrapper = useRef<HTMLDivElement>(null);
  const rf = useReactFlow<RFNode, RFEdge>();

  const load = useCallback((f: Flow) => {
    const { nodes: n, edges: e } = toRF(f);
    setNodes(n);
    setEdges(e);
    setMeta({ id: f.id, name: f.name });
    setSelected({});
    setTimeout(() => rf.fitView({ padding: 0.2 }), 30);
  }, [rf, setEdges, setNodes]);

  useEffect(() => {
    api.flows().then((fs) => {
      setFlows(fs);
      load(fs[0] ?? defaultFlow());
    }).catch((e) => setStatus(String(e)));
    api.accounts().then(setAccounts).catch(() => undefined);
  }, [load]);

  const current = useMemo(() => fromRF(meta, nodes, edges), [meta, nodes, edges]);

  // live validation against the server (also checks bindings against the real account pool)
  useEffect(() => {
    const t = setTimeout(() => {
      api.validateFlow(current).then((r) => {
        setIssues(r.issues);
        setPlan(r.plan);
        setRepoSlots(r.repoSlots);
      }).catch((e) => setIssues([{ level: 'error', message: String(e) }]));
    }, 300);
    return () => clearTimeout(t);
  }, [current]);

  const onConnect = useCallback((c: Connection) => {
    const s = nodes.find((n) => n.id === c.source);
    const t = nodes.find((n) => n.id === c.target);
    if (!s || !t) return;
    const kind = inferKind(s.data.role, t.data.role);
    if (!kind) {
      setStatus(`cannot connect ${ROLE_LABEL[s.data.role]} → ${ROLE_LABEL[t.data.role]}`);
      return;
    }
    setEdges((es) => addEdge(styledEdge({ id: `e-${kind}-${Math.random().toString(36).slice(2, 7)}`, source: s.id, target: t.id, data: { kind } }), es));
  }, [nodes, setEdges]);

  const onDrop = useCallback((ev: DragEvent) => {
    ev.preventDefault();
    const role = ev.dataTransfer.getData('application/decomp-role') as Role;
    if (!role) return;
    const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    setNodes((ns) => [...ns, newNode(role, pos)]);
  }, [rf, setNodes]);

  const patchNode = (id: string, patch: Partial<NodeData>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));

  const save = async (asNew: boolean) => {
    let id = meta.id;
    let name = meta.name;
    if (asNew) {
      name = prompt('Preset name', `${meta.name} copy`) ?? '';
      if (!name) return;
      id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `flow-${Date.now()}`;
    }
    try {
      const r = await api.saveFlow({ ...current, id, name });
      setMeta({ id: r.flow.id, name: r.flow.name });
      setFlows(await api.flows());
      setStatus(`saved "${r.flow.name}"`);
    } catch (e) {
      setStatus(`save failed: ${(e as Error).message}`);
    }
  };

  const node = nodes.find((n) => n.id === selected.node);
  const edge = edges.find((e) => e.id === selected.edge);
  const errors = issues.filter((i) => i.level === 'error');

  return (
    <div className="builder">
      <aside className="palette">
        <h2>Palette</h2>
        {(['orchestrator', 'worker', 'gatekeeper'] as Role[]).map((r) => (
          <div key={r} className="item" draggable onDragStart={(e) => e.dataTransfer.setData('application/decomp-role', r)} style={{ borderLeft: `4px solid ${ROLE_COLOR[r]}` }}>
            <b>{ROLE_LABEL[r]}</b>
            <span className="muted" style={{ fontSize: 12 }}>
              {r === 'orchestrator' ? 'discovers, partitions, dispatches' : r === 'worker' ? 'drafts units; chain tiers to escalate' : 'repo tests + anti-abuse checks'}
            </span>
          </div>
        ))}
        <h3>Edges</h3>
        <div className="muted" style={{ fontSize: 12 }}>
          Drag from a node's right handle to another node. The edge kind follows the roles: Orchestrator→Worker <b>dispatch</b>, Worker→Gate <b>submit</b>,
          Gate→Worker <b>reject/retry</b>, Worker→Worker <b>escalate</b>, Gate→Orchestrator <b>report</b>. Select + Backspace deletes.
        </div>
      </aside>

      <div ref={wrapper} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} style={{ position: 'relative' }}>
        <div className="row" style={{ position: 'absolute', zIndex: 5, top: 10, left: 10, right: 10, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
          <select value={meta.id} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); if (f) load(f); }}>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {!flows.some((f) => f.id === meta.id) && <option value={meta.id}>{meta.name} (unsaved)</option>}
          </select>
          <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} style={{ width: 200 }} aria-label="Preset name" />
          <button className="primary" onClick={() => save(false)} disabled={errors.length > 0}>Save</button>
          <button onClick={() => save(true)}>Save as…</button>
          <button onClick={() => load(defaultFlow())}>Reset to default</button>
          <button className="danger" onClick={async () => { if (confirm(`Delete preset "${meta.name}"?`)) { await api.deleteFlow(meta.id); const fs = await api.flows(); setFlows(fs); load(fs[0] ?? defaultFlow()); } }}>Delete</button>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{status}</span>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={({ nodes: ns, edges: es }) => setSelected({ node: ns[0]?.id, edge: es[0]?.id })}
          colorMode="system"
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background gap={20} />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) => ROLE_COLOR[(n.data as NodeData).role]} />
        </ReactFlow>
      </div>

      <aside className="inspector">
        {node ? (
          <NodeInspector node={node} accounts={accounts} onChange={(p) => patchNode(node.id, p)} onDelete={() => setNodes((ns) => ns.filter((n) => n.id !== node.id))} />
        ) : edge ? (
          <div>
            <h2>Edge</h2>
            <p><span className="chip">{EDGE_STYLE[edge.data!.kind].label}</span></p>
            <p className="muted">{edge.source} → {edge.target}</p>
            <button className="danger" onClick={() => setEdges((es) => es.filter((e) => e.id !== edge.id))}>Delete edge</button>
          </div>
        ) : (
          <div className="muted">Select a node or edge to edit it. Drag roles from the palette onto the canvas.</div>
        )}
        <h3>Plan</h3>
        {plan ? (
          <div style={{ fontSize: 13 }}>
            {plan.tiers.map((t, i) => (
              <div key={t.node}>Tier {i}: <b>{t.label}</b> × {t.instances}{t.retryLoop ? ' (retry loop)' : ''}</div>
            ))}
            <div className="muted">{plan.workerSlots} worker slots · {plan.gatekeepers} gate keeper node(s) · repo has {repoSlots} worktrees{plan.workerSlots > repoSlots ? ' — will scale down' : ''}</div>
          </div>
        ) : <div className="muted">fix errors to compile a plan</div>}
        <h3>Validation</h3>
        <div className="issues">
          {issues.length === 0 && <div style={{ color: 'var(--ok)' }}>✓ valid</div>}
          {issues.map((i, k) => <div key={k} className={`lvl-${i.level === 'error' ? 'error' : 'warn'}`}>{i.level === 'error' ? '✖' : '⚠'} {i.message}</div>)}
        </div>
      </aside>
    </div>
  );
}

function NodeInspector({ node, accounts, onChange, onDelete }: { node: RFNode; accounts: Account[]; onChange: (p: Partial<NodeData>) => void; onDelete: () => void }) {
  const d = node.data;
  const pool = d.pool;
  const setPool = (p: Partial<NodeData['pool']>) => onChange({ pool: { ...pool, ...p } });
  const candidates = accounts.filter((a) => (pool.strategy === 'bound' ? pool.accountIds.includes(a.id) : pool.tags.every((t) => a.tags.includes(t))));
  const models = [...new Set(candidates.flatMap((a) => a.models.map((m) => m.id)))];
  const allTags = [...new Set(accounts.flatMap((a) => a.tags))];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <h2 style={{ color: ROLE_COLOR[d.role] }}>{ROLE_LABEL[d.role]}</h2>
      <label>Label<input value={d.label} onChange={(e) => onChange({ label: e.target.value })} /></label>
      {d.role !== 'orchestrator' && (
        <label>Instances (parallel slots)<input type="number" min={1} max={256} value={d.instances} onChange={(e) => onChange({ instances: Math.max(1, Number(e.target.value)) })} /></label>
      )}
      <h3>Account binding</h3>
      <label>Strategy
        <select value={pool.strategy} onChange={(e) => setPool({ strategy: e.target.value as 'pool' | 'bound' })}>
          <option value="pool">Pool (any enabled account with all tags)</option>
          <option value="bound">Bound (exactly these accounts)</option>
        </select>
      </label>
      {pool.strategy === 'bound' ? (
        <div style={{ display: 'grid', gap: 4 }}>
          {accounts.map((a) => (
            <label key={a.id} className="inline">
              <input type="checkbox" checked={pool.accountIds.includes(a.id)} onChange={(e) => setPool({ accountIds: e.target.checked ? [...pool.accountIds, a.id] : pool.accountIds.filter((x) => x !== a.id) })} />
              {a.label} <span className="muted">({a.provider})</span>
            </label>
          ))}
        </div>
      ) : (
        <label>Required tags (comma separated)
          <input value={pool.tags.join(', ')} onChange={(e) => setPool({ tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} list="tag-list" />
          <datalist id="tag-list">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
      )}
      <div className="muted" style={{ fontSize: 12 }}>Resolves to {candidates.length} account(s): {candidates.map((a) => a.id).join(', ') || 'none'}</div>
      <label>Model override
        <select value={pool.model ?? ''} onChange={(e) => setPool({ model: e.target.value || undefined })}>
          <option value="">first model serving the role</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label>Effort
        <select value={pool.effort ?? ''} onChange={(e) => setPool({ effort: (e.target.value || undefined) as NodeData['pool']['effort'] })}>
          <option value="">model default</option>
          {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}
        </select>
      </label>
      {d.role === 'worker' && (
        <>
          <h3>Retry policy</h3>
          <label>Max attempts at this tier<input type="number" min={1} max={20} value={d.maxAttempts} onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })} /></label>
          <label>Escalate after N attempts without byte improvement<input type="number" min={1} max={20} value={d.stuckAfter} onChange={(e) => onChange({ stuckAfter: Number(e.target.value) })} /></label>
        </>
      )}
      {d.role === 'gatekeeper' && (
        <>
          <h3>Checks</h3>
          {(Object.keys(d.gate) as Array<keyof NodeData['gate']>).map((k) => (
            <label key={k} className="inline">
              <input type="checkbox" checked={d.gate[k]} disabled={k === 'scope'} onChange={(e) => onChange({ gate: { ...d.gate, [k]: e.target.checked } })} />
              {k}{k === 'scope' ? ' (always on)' : k === 'llmReview' ? ' (block-only, uses this node’s binding)' : ''}
            </label>
          ))}
        </>
      )}
      <button className="danger" onClick={onDelete}>Delete node</button>
    </div>
  );
}

export default function FlowBuilder() {
  return (
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  );
}
