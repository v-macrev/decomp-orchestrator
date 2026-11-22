// SPDX-License-Identifier: AGPL-3.0-or-later
// Drag-and-drop hierarchy/flow builder. Nodes are role instances (Orchestrator, Worker tiers,
// Gate Keepers); edge kinds are inferred from the roles they connect, so every edge the canvas
// accepts is one the engine understands. The server validates and compiles the plan live.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Background, ConnectionMode, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, addEdge,
  useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { defaultFlow, type Account, type CapabilityTier, type Difficulty, type EdgeKind, type Flow, type FlowNode, type Role } from '@decomp/core';
import { api, type FlowIssue } from '../api';
import { ConfirmButton } from '../components/ConfirmButton';

type NodeData = FlowNode['data'] & { role: Role };
type RFNode = Node<NodeData, 'role'>;
type RFEdge = Edge<{ kind: EdgeKind; difficulties?: Difficulty[] }>;
const DIFFS: Difficulty[] = ['easy', 'medium', 'hard'];
const CAPS: CapabilityTier[] = ['fast', 'balanced', 'frontier'];

const ROLE_COLOR: Record<Role, string> = { orchestrator: 'var(--orch)', worker: 'var(--worker)', gatekeeper: 'var(--gate)' };
const ROLE_LABEL: Record<Role, string> = { orchestrator: 'Orchestrator', worker: 'Worker tier', gatekeeper: 'Gate Keeper' };
const EDGE_STYLE: Record<EdgeKind, { stroke: string; dash?: string; label: string }> = {
  dispatch: { stroke: 'var(--orch)', label: 'dispatch' },
  submit: { stroke: 'var(--worker)', label: 'submit' },
  reject_retry: { stroke: 'var(--bad)', dash: '6 4', label: 'reject → retry' },
  escalate: { stroke: 'var(--warn)', dash: '2 4', label: 'escalate / promote' },
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
      {/* Four uniquely named connection points; with loose connection mode any of them can start or
          end an edge, and the edge stays attached to exactly the two points the user linked. */}
      <Handle type="source" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Top} id="t" />
      <div className="role">{ROLE_LABEL[data.role]}</div>
      <div className="title">{data.label || '(unnamed)'}</div>
      <div className="meta">
        {data.role !== 'orchestrator' && <>× {data.instances} · </>}
        {binding}
        {pool.model ? ` · ${pool.model}` : ''}
      </div>
      {data.role === 'worker' && (
        <div className="meta">
          <span className={`cap ${data.capability ?? ''}`} title={data.capability ? 'declared capability' : 'inferred from ladder position'}>{data.capability ?? 'auto'}</span>
          {data.costWeight ? <> · cost ×{data.costWeight}</> : null}
          {data.stealDown === false ? ' · no stealing' : ''}
        </div>
      )}
      {data.role === 'worker' && <div className="meta">{data.maxAttempts} attempts, then the next tier</div>}
      {data.role === 'gatekeeper' && (
        <div className="meta">{Object.entries(data.gate).filter(([, v]) => v).map(([k]) => k).join(' · ')}</div>
      )}
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
    </div>
  );
}
const nodeTypes = { role: RoleNode };

function toRF(flow: Flow): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: flow.nodes.map((n) => ({ id: n.id, type: 'role', position: n.position, data: { ...n.data, role: n.type } })),
    edges: flow.edges.map((e) => styledEdge({
      id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
      data: { kind: e.kind, ...(e.difficulties?.length ? { difficulties: e.difficulties } : {}) },
    })),
  };
}

const HANDLE_IDS = new Set(['l', 't', 'r', 'b']);

function styledEdge(e: RFEdge): RFEdge {
  const kind = e.data!.kind;
  const s = EDGE_STYLE[kind];
  const loop = kind === 'reject_retry' || kind === 'escalate' || kind === 'report';
  // Keep the connection points the user chose; only edges without one (older presets) get a default.
  const sourceHandle = e.sourceHandle && HANDLE_IDS.has(e.sourceHandle) ? e.sourceHandle : loop ? 'b' : 'r';
  const targetHandle = e.targetHandle && HANDLE_IDS.has(e.targetHandle) ? e.targetHandle : loop ? 't' : 'l';
  return {
    ...e,
    // Routing rules live on the edge: a dispatch edge shows which difficulties enter the ladder there.
    label: kind === 'dispatch' && e.data!.difficulties?.length ? `dispatch · ${DIFFS.filter((d) => e.data!.difficulties!.includes(d)).join(' + ')}` : s.label,
    animated: kind === 'dispatch',
    sourceHandle,
    targetHandle,
    style: { stroke: s.stroke, strokeWidth: 1.8, strokeDasharray: s.dash },
    labelStyle: { fill: s.stroke, fontSize: 11 },
    labelBgStyle: { fill: 'var(--panel)' },
    markerEnd: { type: MarkerType.ArrowClosed, color: s.stroke },
  };
}

type FlowMetadata = Pick<Flow, 'id' | 'name' | 'runDefaults'>;

function fromRF(base: FlowMetadata, nodes: RFNode[], edges: RFEdge[]): Flow {
  return {
    ...base,
    nodes: nodes.map(({ id, position, data }) => {
      const { role, ...rest } = data;
      return { id, type: role, position: { x: Math.round(position.x), y: Math.round(position.y) }, data: rest };
    }),
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, kind: e.data!.kind, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
      ...(e.data!.kind === 'dispatch' && e.data!.difficulties?.length ? { difficulties: e.data!.difficulties } : {}),
    })),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);

function uniqueId(base: string, taken: Set<string>) {
  const b = slug(base) || 'flow';
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`;
}

/** A fresh flow: one Orchestrator, ready for workers and gate keepers to be added. */
function blankFlow(id: string, name: string): Flow {
  const o = newNode('orchestrator', { x: 0, y: 160 });
  return { id, name, nodes: [{ id: 'orchestrator', type: 'orchestrator', position: o.position, data: (({ role: _r, ...d }) => d)(o.data) }], edges: [] };
}

function newNode(role: Role, position: { x: number; y: number }): RFNode {
  const id = `${role}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id, type: 'role', position,
    data: {
      role, label: ROLE_LABEL[role], instances: role === 'worker' ? 4 : 1,
      pool: { strategy: 'pool', accountIds: [], tags: [] }, maxAttempts: 6, stuckAfter: 3,
      gate: { scope: true, leak: true, cheat: true, integrity: true, repoCompare: true, repoPreflight: true, llmReview: false }, stealDown: true,
    },
  };
}

function Builder() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [meta, setMeta] = useState<FlowMetadata>({ id: 'default', name: 'Default' });
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

  // Remount the canvas on every load: replacing nodes with same-id objects reuses their DOM elements,
  // so React Flow never re-measures them — nodes stay hidden and no edge can attach to their handles.
  const [canvasKey, setCanvasKey] = useState(0);
  const load = useCallback((f: Flow) => {
    const { nodes: n, edges: e } = toRF(f);
    setCanvasKey((k) => k + 1);
    setNodes(n);
    setEdges(e);
    setMeta({ id: f.id, name: f.name, runDefaults: f.runDefaults });
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

  // React Flow re-invokes these when their identity changes: they must be stable, and the selection
  // handler must not set state when nothing changed (otherwise render → handler → render loops).
  const onSelectionChange = useCallback(({ nodes: ns, edges: es }: { nodes: RFNode[]; edges: RFEdge[] }) => {
    const next = { node: ns[0]?.id, edge: es[0]?.id };
    setSelected((cur) => (cur.node === next.node && cur.edge === next.edge ? cur : next));
  }, []);

  const graph = useRef({ nodes, edges });
  graph.current = { nodes, edges };
  const isValidConnection = useCallback((c: Connection | RFEdge) => {
    const { nodes: ns, edges: es } = graph.current;
    const s = ns.find((n) => n.id === c.source);
    const t = ns.find((n) => n.id === c.target);
    return !!s && !!t && s.id !== t.id && !!inferKind(s.data.role, t.data.role) && !es.some((e) => e.source === c.source && e.target === c.target);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const s = nodes.find((n) => n.id === c.source);
    const t = nodes.find((n) => n.id === c.target);
    if (!s || !t) return;
    const kind = inferKind(s.data.role, t.data.role);
    if (!kind) {
      setStatus(`cannot connect ${ROLE_LABEL[s.data.role]} → ${ROLE_LABEL[t.data.role]}`);
      return;
    }
    if (edges.some((e) => e.source === s.id && e.target === t.id)) {
      setStatus(`${s.data.label} → ${t.data.label} is already connected`);
      return;
    }
    setEdges((es) => addEdge(styledEdge({
      id: `e-${kind}-${Math.random().toString(36).slice(2, 7)}`, source: s.id, target: t.id,
      sourceHandle: c.sourceHandle ?? null, targetHandle: c.targetHandle ?? null, data: { kind },
    }), es));
    setStatus(`connected ${s.data.label} → ${t.data.label} (${EDGE_STYLE[kind].label})`);
  }, [nodes, edges, setEdges]);

  // Palette → canvas via pointer events (works with mouse, touch and pen, and in embedded browsers
  // where HTML5 drag-and-drop is unreliable). A click without movement adds at the canvas centre.
  const [ghost, setGhost] = useState<{ role: Role; x: number; y: number } | null>(null);
  const addNodeAt = useCallback((role: Role, screen: { x: number; y: number }) => {
    const pos = rf.screenToFlowPosition(screen);
    const n = newNode(role, { x: pos.x - 95, y: pos.y - 30 });
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }]);
    setSelected({ node: n.id });
    setStatus(`added ${ROLE_LABEL[role]} — connect it from its right/bottom handle`);
  }, [rf, setNodes]);

  const startPaletteDrag = (role: Role, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5) moved = true;
      if (moved) setGhost({ role, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setGhost(null);
      const box = wrapper.current?.getBoundingClientRect();
      if (!box) return;
      if (!moved) {
        const k = nodes.length % 6;
        addNodeAt(role, { x: box.left + box.width / 2 + k * 24, y: box.top + box.height / 2 + k * 24 });
      } else if (ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY >= box.top && ev.clientY <= box.bottom) {
        addNodeAt(role, { x: ev.clientX, y: ev.clientY });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const patchNode = (id: string, patch: Partial<NodeData>) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));

  /** Toggle a difficulty on a dispatch edge. A difficulty belongs to one dispatch edge, so it moves. */
  const toggleDifficulty = (edgeId: string, d: Difficulty) =>
    setEdges((es) => es.map((e) => {
      if (e.data!.kind !== 'dispatch') return e;
      const cur = e.data!.difficulties ?? [];
      const next = e.id === edgeId ? (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]) : cur.filter((x) => x !== d);
      if (next.length === cur.length && next.every((x) => cur.includes(x))) return e;
      return styledEdge({ ...e, data: { ...e.data!, difficulties: next } });
    }));

  const saved = flows.some((f) => f.id === meta.id);
  /** Drafts may be saved with validation errors; a run refuses an invalid flow. */
  const save = async (asNew: boolean) => {
    const name = meta.name.trim() || 'Untitled flow';
    const id = asNew || !saved ? uniqueId(name, new Set(flows.map((f) => f.id))) : meta.id;
    try {
      const r = await api.saveFlow({ ...current, id, name });
      setMeta({ id: r.flow.id, name: r.flow.name, runDefaults: r.flow.runDefaults });
      setFlows(await api.flows());
      const errs = r.issues.filter((i) => i.level === 'error').length;
      setStatus(errs ? `saved "${r.flow.name}" as a draft with ${errs} error(s) — fix them before running it` : `saved "${r.flow.name}"`);
    } catch (e) {
      setStatus(`save failed: ${(e as Error).message}`);
    }
  };

  const newFlow = () => {
    const taken = new Set(flows.map((f) => f.id));
    const id = uniqueId('new-flow', taken);
    load(blankFlow(id, `New flow ${id.replace(/^new-flow-?/, '') || ''}`.trim()));
    setStatus('new flow: drag or click roles in the palette to add them, then Save');
  };

  const node = nodes.find((n) => n.id === selected.node);
  const edge = edges.find((e) => e.id === selected.edge);
  const errors = issues.filter((i) => i.level === 'error');

  return (
    <div className="builder">
      <aside className="palette">
        <h2>Palette</h2>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Drag onto the canvas, or click to add.</div>
        {(['orchestrator', 'worker', 'gatekeeper'] as Role[]).map((r) => (
          <div
            key={r}
            className="item"
            role="button"
            tabIndex={0}
            aria-label={`Add ${ROLE_LABEL[r]}`}
            onPointerDown={(e) => startPaletteDrag(r, e)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              const box = wrapper.current?.getBoundingClientRect();
              if (box) addNodeAt(r, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
            }}
            style={{ borderLeft: `4px solid ${ROLE_COLOR[r]}` }}
          >
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

      <div ref={wrapper} style={{ position: 'relative' }}>
        <div className="row" style={{ position: 'absolute', zIndex: 5, top: 10, left: 10, right: 10, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
          <select value={meta.id} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); if (f) load(f); }} aria-label="Preset">
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {!saved && <option value={meta.id}>{meta.name} (unsaved)</option>}
          </select>
          <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} style={{ width: 180 }} aria-label="Preset name" placeholder="Preset name" />
          <button className="primary" onClick={() => save(false)} title={saved ? 'Update this preset' : 'Save as a new preset'}>{saved ? 'Save' : 'Save new'}</button>
          {saved && <button onClick={() => save(true)} title="Save a copy under the name in the field">Save as copy</button>}
          <button onClick={newFlow}>New flow</button>
          <button onClick={() => load({ ...defaultFlow(), ...meta })} title="Replace the canvas with the default ladder (not saved until you click Save)">Load template</button>
          {saved && (
            <ConfirmButton onConfirm={async () => { await api.deleteFlow(meta.id); const fs = await api.flows(); setFlows(fs); load(fs[0] ?? defaultFlow()); setStatus(`deleted "${meta.name}"`); }} confirmLabel={`Delete "${meta.name}"?`}>
              Delete
            </ConfirmButton>
          )}
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{status}</span>
        </div>
        <ReactFlow
          key={canvasKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={36}
          isValidConnection={isValidConnection}
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
            {edge.data!.kind === 'dispatch' && (
              <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Routing rule</h3>
                <div className="muted" style={{ fontSize: 12 }}>Packets of these difficulties enter the ladder at this edge's worker tier. Unassigned difficulties go to the tier with the nearest capability.</div>
                <div className="toggle-row">
                  {DIFFS.map((d) => (
                    <button key={d} className={edge.data!.difficulties?.includes(d) ? 'on' : ''} aria-pressed={!!edge.data!.difficulties?.includes(d)} onClick={() => toggleDifficulty(edge.id, d)}>
                      <span className={`diff ${d}`}>{d}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button className="danger" onClick={() => setEdges((es) => es.filter((e) => e.id !== edge.id))}>Delete edge</button>
          </div>
        ) : (
          <div className="muted">Select a node or edge to edit it. Drag roles from the palette onto the canvas.</div>
        )}
        <h3>Plan</h3>
        {plan ? (
          <div style={{ fontSize: 13 }}>
            {plan.tiers.map((t, i) => (
              <div key={t.node}>
                Tier {i}: <span className={`cap ${t.capability}`}>{t.capability}</span> <b>{t.label}</b> × {t.instances}{t.retryLoop ? ' (retry loop)' : ''}
                {t.capabilityInferred ? <span className="muted"> · inferred</span> : null}
              </div>
            ))}
            <div style={{ margin: '6px 0' }}>
              {DIFFS.map((d) => (
                <div key={d}><span className={`diff ${d}`}>{d}</span> → tier {plan.route[d]} <span className="muted">({plan.routeSource[d] === 'edge' ? 'edge rule' : 'nearest capability'})</span></div>
              ))}
            </div>
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
          <label title="The only retry setting: a packet gets exactly this many attempts on this tier, then moves to the next tier (on the last tier, it fails). Format-only rejections (header, lint, output contract) do not count.">Attempts at this tier<input type="number" min={1} max={20} value={d.maxAttempts} onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })} /></label>
          <h3>Capability routing</h3>
          <label>Capability tier
            <select value={d.capability ?? ''} onChange={(e) => { const c = (e.target.value || undefined) as CapabilityTier | undefined; onChange({ capability: c, pool: { ...pool, capability: c } }); }}>
              <option value="">auto (from ladder position)</option>
              {CAPS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="muted" style={{ fontSize: 12 }}>Accounts whose model declares this capability are preferred; others are used only when none do.</div>
          <label>Relative cost weight<input type="number" min={0.1} step={0.1} value={d.costWeight ?? ''} placeholder="—" onChange={(e) => onChange({ costWeight: e.target.value ? Number(e.target.value) : undefined })} /></label>
          <label className="inline"><input type="checkbox" checked={d.stealDown !== false} onChange={(e) => onChange({ stealDown: e.target.checked })} />Pull lower-tier backlog when idle (work stealing)</label>
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
