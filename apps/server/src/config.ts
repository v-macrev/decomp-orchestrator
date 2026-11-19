// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const ServerConfig = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().default(8787),
  dbPath: z.string().default('data/orchestrator.db'),
  /** sim: in-memory repository + mock providers allowed; repo: drive a real skyrim_decomp checkout. */
  mode: z.enum(['sim', 'repo']).default('sim'),
  accountsFile: z.string().default('config/accounts.json'),
  repo: z
    .object({
      path: z.string(),
      baseRef: z.string().default('origin/main'),
      worktreeRoot: z.string().default('data/worktrees'),
      localDir: z.string(),
      python: z.string().default(process.platform === 'win32' ? 'python' : 'python3'),
      slots: z.number().int().min(1).max(128).default(8),
      sandbox: z
        .discriminatedUnion('mode', [
          z.object({ mode: z.literal('local') }),
          z.object({ mode: z.literal('docker'), image: z.string(), cpus: z.number().optional(), memory: z.string().optional() }),
        ])
        .default({ mode: 'local' }),
    })
    .optional(),
  sim: z
    .object({
      slots: z.number().int().min(1).max(256).default(16),
      compareLatencyMs: z.tuple([z.number(), z.number()]).default([150, 600]),
      infraRate: z.number().min(0).max(1).default(0.01),
    })
    .default({ slots: 16, compareLatencyMs: [150, 600], infraRate: 0.01 }),
  engine: z
    .object({
      leaseMs: z.number().int().optional(),
      heartbeatMs: z.number().int().optional(),
      maxInfraFailures: z.number().int().optional(),
      providerTimeoutMs: z.number().int().optional(),
      maxOutputTokens: z.number().int().optional(),
      infraBackoffMs: z.number().int().optional(),
    })
    .default({}),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

/** Root of the orchestrator checkout (two levels above apps/server). */
export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(ROOT, p));

export function loadConfig(): ServerConfig {
  const path = fromRoot(process.env.ORCH_CONFIG ?? 'config/orchestrator.json');
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const cfg = ServerConfig.parse(raw);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (cfg.mode === 'repo' && !cfg.repo) throw new Error('mode "repo" requires a "repo" section in config/orchestrator.json');
  return cfg;
}
