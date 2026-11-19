// SPDX-License-Identifier: AGPL-3.0-or-later
// Composition root: wires store, telemetry, repository adapter, account pool, providers and engine.
import { existsSync, readFileSync } from 'node:fs';
import { Account, defaultFlow, type Account as AccountT } from '@decomp/core';
import { fromRoot, type ServerConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { RunEngine } from './orchestrator/engine.js';
import { seedRepoLessons } from './orchestrator/lessons.js';
import { AccountPool } from './pool/scheduler.js';
import { ProviderRegistry } from './providers/registry.js';
import { SimRepo } from './repo/simRepo.js';
import { SrRepo, type SrRepoConfig } from './repo/srRepo.js';
import type { RepoAdapter } from './repo/types.js';
import { EventBus } from './telemetry/events.js';

export interface App {
  cfg: ServerConfig;
  store: Store;
  events: EventBus;
  repo: RepoAdapter;
  pool: AccountPool;
  providers: ProviderRegistry;
  engine: RunEngine;
  reloadAccounts(): void;
  close(): Promise<void>;
}

export async function createApp(cfg: ServerConfig, opts: { quiet?: boolean } = {}): Promise<App> {
  const store = new Store(openDatabase(cfg.dbPath === ':memory:' ? ':memory:' : fromRoot(cfg.dbPath)));
  const events = new EventBus(store, (e) => {
    if (opts.quiet || e.level === 'debug' || (e.level === 'info' && !e.kind.startsWith('run.') && !e.kind.startsWith('account.'))) return;
    const t = new Date(e.ts).toISOString().slice(11, 19);
    console.log(`${t} ${e.level.toUpperCase().padEnd(5)} ${e.kind.padEnd(18)} ${e.msg}`);
  });

  let repo: RepoAdapter;
  let sim: SimRepo | null = null;
  if (cfg.mode === 'repo') {
    repo = new SrRepo(srRepoConfig(cfg));
  } else {
    sim = new SimRepo({ slots: cfg.sim.slots, compareLatencyMs: cfg.sim.compareLatencyMs, infraRate: cfg.sim.infraRate });
    repo = sim;
  }
  await repo.init();

  seedAccounts(store, cfg);
  if (!store.listFlows().length) store.upsertFlow(defaultFlow());
  await seedRepoLessons(store, repo).catch(() => 0);

  const pool = new AccountPool(store.listAccounts(), store, events);
  const providers = new ProviderRegistry({ oracle: sim ?? undefined });
  const engine = new RunEngine({ store, pool, providers, repo, events }, cfg.engine);

  return {
    cfg, store, events, repo, pool, providers, engine,
    reloadAccounts() {
      pool.setAccounts(store.listAccounts());
    },
    async close() {
      engine.close();
      pool.close();
      store.db.close();
    },
  };
}

export function srRepoConfig(cfg: ServerConfig): SrRepoConfig {
  const r = cfg.repo!;
  const wsl = r.host.kind === 'wsl';
  // WSL paths are Linux paths inside the distribution: never resolve them against this checkout.
  const at = (p: string) => (wsl ? p : fromRoot(p));
  return {
    repoPath: at(r.path), baseRef: r.baseRef, worktreeRoot: at(r.worktreeRoot), localDir: at(r.localDir),
    python: wsl && r.python === 'python' ? 'python3' : r.python, slots: r.slots, host: r.host, sandbox: r.sandbox,
  };
}

function seedAccounts(store: Store, cfg: ServerConfig) {
  if (store.listAccounts().length) return;
  const file = fromRoot(cfg.accountsFile);
  if (existsSync(file)) {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    for (const a of list) store.upsertAccount(Account.parse(a));
    return;
  }
  if (cfg.mode === 'sim') for (const a of demoAccounts()) store.upsertAccount(a);
}

/** Simulation pool: two Claude workspaces, a GPT account, a local model and a strong tier. */
export function demoAccounts(): AccountT[] {
  const m = (id: string, price: [number, number], roles: AccountT['models'][number]['roles'] = ['worker', 'gatekeeper', 'orchestrator']) => ({
    id, roles, contextTokens: 200_000, maxOutputTokens: 32_000, priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10,
  });
  const lim = (rpm: number, conc: number) => ({ requestsPerMinute: rpm, inputTokensPerMinute: 2_000_000, outputTokensPerMinute: 400_000, maxConcurrency: conc });
  return [
    { id: 'sim-claude-ws-a', label: 'Claude · workspace A (sim)', provider: 'mock', workspace: 'anthropic:ws-a', auth: { type: 'none' }, models: [m('claude-sonnet-5-5', [2, 10])], limits: lim(240, 8), tags: ['cheap'], priority: 1, enabled: true, options: { latencyMs: [300, 1500], skill: 0.55, serverRpm: 150, rateLimitRate: 0.02 } },
    { id: 'sim-claude-ws-b', label: 'Claude · workspace B (sim)', provider: 'mock', workspace: 'anthropic:ws-b', auth: { type: 'none' }, models: [m('claude-sonnet-5-5', [2, 10])], limits: lim(240, 8), tags: ['cheap'], priority: 1, enabled: true, options: { latencyMs: [300, 1500], skill: 0.55, outages: [[20_000, 45_000]] } },
    { id: 'sim-gpt-a', label: 'GPT · org A (sim)', provider: 'mock', workspace: 'openai:org-a', auth: { type: 'none' }, models: [m('gpt-5.5', [2.5, 12])], limits: lim(300, 6), tags: ['cheap', 'strong'], priority: 0, enabled: true, options: { latencyMs: [400, 1800], skill: 0.6, quotaAfterRequests: 400 } },
    { id: 'sim-local', label: 'Local · vLLM (sim)', provider: 'mock', workspace: 'local', auth: { type: 'none' }, models: [m('qwen-coder-local', [0, 0])], limits: lim(10_000, 4), tags: ['cheap'], priority: -1, enabled: true, options: { latencyMs: [1500, 4000], skill: 0.35 } },
    { id: 'sim-claude-opus', label: 'Claude Opus · workspace A (sim)', provider: 'mock', workspace: 'anthropic:ws-a', auth: { type: 'none' }, models: [m('claude-opus-5-5', [4, 20])], limits: lim(120, 4), tags: ['strong', 'orchestrator'], priority: 2, enabled: true, options: { latencyMs: [800, 3000], skill: 0.85, serverErrorRate: 0.03 } },
  ].map((a) => Account.parse(a));
}
