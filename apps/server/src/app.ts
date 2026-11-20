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
import { SkillCurator } from './skills/curator.js';
import { SkillRegistry } from './skills/registry.js';
import { ShadowEvaluator } from './skills/shadow.js';
import { CuratorModel } from './skills/synth.js';

export interface App {
  cfg: ServerConfig;
  store: Store;
  events: EventBus;
  repo: RepoAdapter;
  pool: AccountPool;
  providers: ProviderRegistry;
  engine: RunEngine;
  skills: SkillRegistry;
  curator: SkillCurator;
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
    sim = new SimRepo({ slots: cfg.sim.slots, compareLatencyMs: cfg.sim.compareLatencyMs, infraRate: cfg.sim.infraRate, traps: cfg.sim.traps });
    repo = sim;
  }
  // Before init: it resets every slot and may clear stale git locks, which the operator should see.
  repo.notice = (kind, msg) => events.emit(kind, msg, { level: 'warn' });
  await repo.init();

  seedAccounts(store, cfg);
  if (!store.listFlows().length) store.upsertFlow(defaultFlow());
  await seedRepoLessons(store, repo).catch(() => 0);

  const pool = new AccountPool(store.listAccounts(), store, events);
  const providers = new ProviderRegistry({ oracle: sim ?? undefined });
  const skills = new SkillRegistry(store, cfg.dbPath === ':memory:' ? null : fromRoot(cfg.skillsDir));
  skills.failStaleJobs();
  const engine = new RunEngine({ store, pool, providers, repo, events, skills }, cfg.engine);
  const shadow = new ShadowEvaluator({ store, registry: skills, repo, pool, providers, events, engine, context: engine.contextV2 });
  const curator = new SkillCurator({ store, registry: skills, repo, events, engine, shadow, model: new CuratorModel(pool, providers), cwd: fromRoot('.') }, { shadow: { cases: cfg.skills.shadowCases, repeats: cfg.skills.shadowRepeats } });
  engine.afterRun = (runId) => {
    try {
      curator.run('curate', { runId });
    } catch (e) {
      events.emit('skills.job', `auto-curation skipped: ${(e as Error).message}`, { runId, level: 'warn' });
    }
  };

  return {
    cfg, store, events, repo, pool, providers, engine, skills, curator,
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
    repoPath: at(r.path), baseRef: r.baseRef, upstream: r.upstream, worktreeRoot: at(r.worktreeRoot), localDir: at(r.localDir),
    python: wsl && r.python === 'python' ? 'python3' : r.python, slots: r.slots, host: r.host, sandbox: r.sandbox, ...(r.functionTable ? { functionTable: at(r.functionTable) } : {}),
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

/**
 * Simulation pool across capability tiers: Haiku (fast) on two workspaces, Sonnet + GPT (balanced),
 * Opus (frontier), and a free local model (fast, weaker). Prices follow the providers' list prices
 * per MTok, including cache reads (0.1×) and 5-minute cache writes (1.25×).
 */
export function demoAccounts(): AccountT[] {
  type Cap = 'fast' | 'balanced' | 'frontier';
  const m = (id: string, price: [number, number], capability: Cap, costWeight: number, roles: AccountT['models'][number]['roles'] = ['worker', 'gatekeeper', 'orchestrator']) => ({
    id, roles, capability, costWeight, contextTokens: 1_000_000, maxOutputTokens: 32_000,
    priceInPerMTok: price[0], priceOutPerMTok: price[1], priceCacheReadPerMTok: price[0] / 10, priceCacheWritePerMTok: price[0] * 1.25,
  });
  const lim = (rpm: number, conc: number) => ({ requestsPerMinute: rpm, inputTokensPerMinute: 2_000_000, outputTokensPerMinute: 400_000, maxConcurrency: conc });
  return [
    { id: 'sim-haiku-ws-a', label: 'Claude Haiku · workspace A (sim)', provider: 'mock', workspace: 'anthropic:ws-a', auth: { type: 'none' }, models: [m('claude-haiku-5-5', [0.1, 0.5], 'fast', 1)], limits: lim(400, 8), tags: ['cheap'], priority: 1, enabled: true, options: { latencyMs: [200, 900], serverRpm: 300, rateLimitRate: 0.02 } },
    { id: 'sim-haiku-ws-b', label: 'Claude Haiku · workspace B (sim)', provider: 'mock', workspace: 'anthropic:ws-b', auth: { type: 'none' }, models: [m('claude-haiku-5-5', [0.1, 0.5], 'fast', 1)], limits: lim(400, 8), tags: ['cheap'], priority: 1, enabled: true, options: { latencyMs: [200, 900], outages: [[20_000, 45_000]] } },
    { id: 'sim-claude-ws-a', label: 'Claude Sonnet · workspace A (sim)', provider: 'mock', workspace: 'anthropic:ws-a', auth: { type: 'none' }, models: [m('claude-sonnet-5-5', [2, 10], 'balanced', 4)], limits: lim(240, 6), tags: ['cheap', 'strong'], priority: 1, enabled: true, options: { latencyMs: [300, 1500], serverRpm: 150, rateLimitRate: 0.02 } },
    { id: 'sim-gpt-a', label: 'GPT · org A (sim)', provider: 'mock', workspace: 'openai:org-a', auth: { type: 'none' }, models: [m('gpt-5.5', [2.5, 12], 'balanced', 5)], limits: lim(300, 6), tags: ['cheap', 'strong'], priority: 0, enabled: true, options: { latencyMs: [400, 1800], quotaAfterRequests: 400 } },
    { id: 'sim-local', label: 'Local · vLLM (sim)', provider: 'mock', workspace: 'local', auth: { type: 'none' }, models: [m('qwen-coder-local', [0, 0], 'fast', 0.5)], limits: lim(10_000, 4), tags: ['cheap'], priority: -1, enabled: true, options: { latencyMs: [1500, 4000], skillMatrix: { fast: { easy: 0.6, medium: 0.25, hard: 0.05 } } } },
    { id: 'sim-claude-opus', label: 'Claude Opus · workspace A (sim)', provider: 'mock', workspace: 'anthropic:ws-a', auth: { type: 'none' }, models: [m('claude-opus-5-5', [4, 20], 'frontier', 10)], limits: lim(120, 4), tags: ['strong', 'orchestrator'], priority: 2, enabled: true, options: { latencyMs: [800, 3000], serverErrorRate: 0.03 } },
  ].map((a) => Account.parse(a));
}
