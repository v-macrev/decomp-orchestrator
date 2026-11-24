// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tip from '@radix-ui/react-tooltip';
import * as Toggle from '@radix-ui/react-toggle-group';
import { Command } from 'cmdk';
import { Toaster, toast } from 'sonner';
import { Activity as ActivityIcon, Boxes, Cpu, Flag, HardDrive, KeyRound, LayoutGrid, ListChecks, Moon, Play, Search, Sparkles, Sun, Target, Workflow } from 'lucide-react';
import { api, getToken, setToken } from './api';
import { cn, useFile, useSummary, when, type Fn, type Summary } from './desk/lib';
import { Activity, Flags, Local, Models, NearMisses, Overview, Solved, Templates } from './desk/views';
import Accounts from './pages/Accounts';
import FlowBuilder from './pages/FlowBuilder';
import Runs from './pages/Runs';
import Skills from './pages/Skills';
import './styles.css';
import './orch.css';

type DeskView = ComponentType<{ s: Summary; open: string | null; setOpen: (v: string | null) => void }>;
/** Desk views read the collected records (read-only); the others are the orchestrator's own pages. */
const VIEWS: Array<{ id: string; label: string; icon: ComponentType<{ className?: string }>; desk?: DeskView }> = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, desk: Overview },
  { id: 'runs', label: 'Runs', icon: Play },
  { id: 'solved', label: 'Solved', icon: ListChecks, desk: Solved },
  { id: 'near', label: 'Near misses', icon: Target, desk: NearMisses },
  { id: 'templates', label: 'Templates and queue', icon: Boxes, desk: Templates },
  { id: 'models', label: 'Models', icon: Cpu, desk: Models },
  { id: 'activity', label: 'Activity', icon: ActivityIcon, desk: Activity },
  { id: 'local', label: 'Local model', icon: HardDrive, desk: Local },
  { id: 'flags', label: 'Flag reports', icon: Flag, desk: Flags },
  { id: 'flow', label: 'Flow builder', icon: Workflow },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'accounts', label: 'Accounts', icon: KeyRound },
];
const DENSITY = ['comfortable', 'compact', 'dense'] as const;

// Route and settings: #/view/0xrva?theme=dark&density=compact (settings in the hash win over the stored ones)
function readHash() {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view = '', rva = null] = path.split('/');
  return { view: VIEWS.some((v) => v.id === view) ? view : '', rva, q: new URLSearchParams(query) };
}
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };
const first = readHash();
const theme0 = first.q.get('theme') ?? stored('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const density0 = first.q.get('density') ?? stored('density') ?? 'compact';
document.documentElement.dataset.theme = theme0; // before the first paint
document.documentElement.dataset.density = density0;

interface Health { mode: string; repo: string; slots: number; desk: boolean }

function App() {
  const [route, setRoute] = useState(readHash);
  const [theme, setTheme] = useState(theme0);
  const [density, setDensity] = useState(density0);
  const [pal, setPal] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.health().then((h) => setHealth(h)).catch((e) => setErr(String(e))); }, []);
  const { s, error } = useSummary(!!health?.desk, (a, b) => {
    const d = b.kpi.verified.n - a.kpi.verified.n;
    if (d) toast(`Verified matches: ${a.kpi.verified.n} to ${b.kpi.verified.n}`);
    const f = b.kpi.filed.n - a.kpi.filed.n;
    if (f) toast(`Filed functions: ${a.kpi.filed.n} to ${b.kpi.filed.n}`);
  });
  const fns = useFile<Fn[]>(pal && s ? 'functions' : null, s?.generatedAt ?? 0);
  useEffect(() => { const f = () => setRoute(readHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; store('theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.dataset.density = density; store('density', density); }, [density]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal((x) => !x); } };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, []);
  const go = (view: string, rva?: string | null) => { location.hash = `/${view}${rva ? '/' + rva : ''}`; setPal(false); };
  // Desk views need the real checkout (repo mode); Local model only when one is configured.
  const views = VIEWS.filter((v) => !v.desk || (health?.desk && (v.id !== 'local' || (s?.localModels.length ?? 0) > 0)));
  const current = VIEWS.find((v) => v.id === route.view && (!v.desk || health?.desk !== false)) ?? VIEWS.find((v) => v.id === (health?.desk === false ? 'runs' : 'overview'))!;
  const Desk = current.desk;
  useEffect(() => { document.querySelector('nav [aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [current.id, views.length]); // narrow screens scroll the pills
  const old = s && Date.now() - s.generatedAt > 15 * 60_000;
  return (
    <Tip.Provider>
      <div className="mx-auto max-w-[5200px] px-4 pt-3 pb-8">
        <header className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-sm font-semibold">decomp orchestrator</h1>
          {health && <span title={health.repo} className="rounded-full bg-coolsoft px-2 py-0.5 text-xs text-cool">{health.mode} · {health.slots} slots</span>}
          <nav className="order-last flex w-full gap-1 overflow-x-auto py-1" aria-label="Views">
            {views.map((v) => (
              <button key={v.id} onClick={() => go(v.id)} aria-current={current.id === v.id ? 'page' : undefined}
                className={cn('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[.8125rem] whitespace-nowrap', current.id === v.id ? 'bg-ink text-card' : 'text-mute hover:bg-card hover:text-ink')}>
                <v.icon className="size-3.5" />{v.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-mute">
            {health?.desk && <span>{s ? <>data as of <b className="text-ink">{when(s.generatedAt)}</b>{old && ' (collector not running?)'}</> : error ?? 'loading'}</span>}
            {s && <span title={s.notes.status}>origin/main fetched {when(s.fetchedAt)}</span>}
            <Toggle.Root type="single" value={density} onValueChange={(v) => v && setDensity(v)} aria-label="Density" className="card flex !rounded-full p-0.5">
              {DENSITY.map((d) => <Toggle.Item key={d} value={d} className="rounded-full px-2 py-1 capitalize data-[state=on]:bg-soft data-[state=on]:text-ink">{d}</Toggle.Item>)}
            </Toggle.Root>
            <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Switch theme" className="card !rounded-full p-2">{theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}</button>
            <button onClick={() => setPal(true)} className="card flex items-center gap-1.5 !rounded-full px-3 py-1.5"><Search className="size-3.5" />Ctrl K</button>
          </div>
        </header>
        {err && <div className="card mb-3 flex flex-wrap items-center gap-3 p-3 text-sm text-warm">API unreachable{err.includes('unauthorized') ? ' (token)' : ''}<TokenInput /></div>}
        {Desk ? (
          <main>
            {error && !s && <p className="card p-4 text-sm text-mute">Desk data is not available: {error}</p>}
            {s && <Desk s={s} open={route.rva} setOpen={(v) => go(current.id, v)} />}
          </main>
        ) : (
          <div className="orch">
            {current.id === 'flow' ? <FlowBuilder key={theme} /> : current.id === 'accounts' ? <Accounts /> : current.id === 'skills' ? <Skills />
              : health ? <Runs key={health.mode} mode={health.mode} />
                : <main className="page muted" role="status">{err ? 'Cannot load runs until the server connects.' : 'Connecting to the server…'}</main>}
          </div>
        )}
      </div>
      <Command.Dialog open={pal} onOpenChange={setPal} label="Command palette" className="card fixed top-[12vh] left-1/2 z-50 w-[36rem] max-w-[92vw] -translate-x-1/2 overflow-hidden" overlayClassName="fixed inset-0 z-40 bg-black/35">
        <Command.Input placeholder="View, setting, address or function name" className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none" />
        <Command.List className="max-h-80 overflow-auto p-2 text-sm">
          <Command.Empty className="p-3 text-mute">Nothing found</Command.Empty>
          <Command.Group heading="Views">{views.map((v) => <Command.Item key={v.id} onSelect={() => go(v.id)} className="rounded-lg px-3 py-1.5">{v.label}</Command.Item>)}</Command.Group>
          <Command.Group heading="Settings">
            <Command.Item onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="rounded-lg px-3 py-1.5">Switch to {theme === 'dark' ? 'light' : 'dark'} theme</Command.Item>
            {DENSITY.map((d) => <Command.Item key={d} onSelect={() => setDensity(d)} className="rounded-lg px-3 py-1.5">Density {d}</Command.Item>)}
          </Command.Group>
          {fns && <Command.Group heading="Functions">{fns.map((f) => <Command.Item key={f.rva} value={`${f.name} ${f.va} ${f.rva}`} onSelect={() => go('solved', f.rva)} className="flex gap-3 rounded-lg px-3 py-1.5"><span className="font-mono text-xs text-mute">{f.va}</span><span className="truncate">{f.name}</span></Command.Item>)}</Command.Group>}
        </Command.List>
      </Command.Dialog>
      <Toaster theme={theme as 'light' | 'dark'} position="bottom-right" />
    </Tip.Provider>
  );
}

/** Inline token entry (window.prompt is unavailable in embedded browsers). */
function TokenInput() {
  const [v, setV] = useState(getToken());
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setToken(v.trim()); location.reload(); }}>
      <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="ORCH_API_TOKEN" aria-label="API token" className="h-8 w-48 rounded-full border border-line bg-card px-3 text-ink" />
      <button type="submit" className="rounded-full bg-ink px-3 text-card">Set token</button>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
