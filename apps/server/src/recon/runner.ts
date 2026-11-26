// SPDX-License-Identifier: AGPL-3.0-or-later
// The deterministic tier's way to the engine: one bounded process per packet, the request in a private file
// (so the WSL host keeps its cancel handshake on stdin, R-1), the model name fixed by the engine's version.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Host } from '../repo/host.js';
import { runEngine, type EngineRun } from './process.js';
import { engineModelName, PROTOCOL_VERSION, type EngineRequest } from './protocol.js';

/** Where the engine reads and works for one packet; paths as the engine's host sees them. */
export interface EngineContext {
  /** The slot's worktree at the pinned base. */
  worktree: string;
  /** The checkout holding the private contrib config (image path, toolchain). */
  checkout: string;
  /** Private engine data: always under the checkout's `.local/`. */
  dataDir: string;
}

export interface ReconRunnerOptions {
  host: Host;
  /** Directory holding `recon/`, as the host sees it. */
  engineDir: string;
  /** The interpreter (R-7: configurable, e.g. a virtual environment's). */
  python: string;
  /** Extra module paths after the engine's own (a virtual environment's site-packages). */
  pythonPath?: string[];
  /** The engine's version, which names its attempts (`recon-engine-<version>`). */
  version: string;
  /** Default wall-clock bound of one process. */
  timeoutMs: number;
  /** Private scratch directory for request files when no engine context gives one (host path). */
  scratch: string;
  /** Replaces `-m recon serve` (tests run a stand-in engine). */
  args?: string[];
}

export type SolveInput = Omit<EngineRequest, 'protocol' | 'command' | 'modelName' | 'requestId'> & { requestId?: string };

export class ReconRunner {
  readonly modelName: string;
  constructor(readonly o: ReconRunnerOptions) {
    this.modelName = engineModelName(o.version);
  }

  /** Solve one packet. Every failure of the process is an infrastructure failure of the returned run. */
  async solve(input: SolveInput, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<EngineRun & { request: EngineRequest }> {
    const { host } = this.o;
    const requestId = input.requestId ?? `rq-${randomUUID().slice(0, 18)}`;
    const dir = host.path.join(input.dataDir ?? this.o.scratch, 'requests');
    const file = host.path.join(dir, `${requestId}.json`);
    const request: EngineRequest = { ...input, protocol: PROTOCOL_VERSION, command: 'solve', requestId, modelName: this.modelName };
    try {
      mkdirSync(host.fsPath(dir), { recursive: true });
      writeFileSync(host.fsPath(file), JSON.stringify(request) + '\n', 'utf8');
    } catch (e) {
      return { ok: false, kind: 'spawn', detail: `the request file could not be written: ${(e as Error).message.slice(0, 200)}`, progress: [], durationMs: 0, request };
    }
    try {
      const run = await runEngine(request, {
        host, engineDir: this.o.engineDir, python: this.o.python, timeoutMs: opts.timeoutMs ?? this.o.timeoutMs, signal: opts.signal,
        args: [...(this.o.args ?? ['-s', '-B', '-m', 'recon', 'serve']), '--request', file],
        requestFile: true, pythonPath: this.o.pythonPath,
      });
      return { ...run, request };
    } finally {
      try {
        rmSync(host.fsPath(file), { force: true });
      } catch {
        /* a leftover request file is private and harmless */
      }
    }
  }
}

/** The engine package's version, read from its source (`ENGINE_VERSION = "x.y.z"`). */
export function readEngineVersion(engineDirFs: string): string {
  const text = readFileSync(path.join(engineDirFs, 'recon', '__init__.py'), 'utf8');
  const m = /^ENGINE_VERSION\s*=\s*"([0-9A-Za-z.+-]{1,32})"/m.exec(text);
  if (!m) throw new Error('the engine package declares no ENGINE_VERSION');
  return m[1]!;
}
