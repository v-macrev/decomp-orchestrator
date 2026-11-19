// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, getToken, setToken } from './api';
import Accounts from './pages/Accounts';
import FlowBuilder from './pages/FlowBuilder';
import Runs from './pages/Runs';
import Skills from './pages/Skills';
import './styles.css';

type Tab = 'runs' | 'flow' | 'skills' | 'accounts';
const TAB_KEY = 'decomp.tab';

function App() {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'runs';
    } catch {
      return 'runs';
    }
  });
  const [health, setHealth] = useState<{ mode: string; repo: string; slots: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  useEffect(() => {
    api.health().then(setHealth).catch((e) => setErr(String(e)));
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">decomp·orchestrator</span>
        <nav className="tabs">
          {([['runs', 'Runs & telemetry'], ['flow', 'Flow builder'], ['skills', 'Skills & optimization'], ['accounts', 'Accounts']] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <span className="grow" />
        {health && <span className="muted" style={{ fontSize: 12 }}>{health.mode} mode · {health.repo} · {health.slots} worktree slots</span>}
        {err && (
          <span className="lvl-error" style={{ fontSize: 12 }}>
            API unreachable{err.includes('unauthorized') ? ' (token)' : ''}{' '}
            <TokenInput />
          </span>
        )}
      </header>
      {tab === 'flow' ? <FlowBuilder /> : tab === 'accounts' ? <Accounts /> : tab === 'skills' ? <Skills /> : <Runs mode={health?.mode ?? 'sim'} />}
    </div>
  );
}

/** Inline token entry (window.prompt is unavailable in embedded browsers). */
function TokenInput() {
  const [v, setV] = useState(getToken());
  return (
    <form className="row" style={{ display: 'inline-flex' }} onSubmit={(e) => { e.preventDefault(); setToken(v.trim()); location.reload(); }}>
      <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="ORCH_API_TOKEN" aria-label="API token" style={{ width: 160 }} />
      <button type="submit">Set token</button>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
