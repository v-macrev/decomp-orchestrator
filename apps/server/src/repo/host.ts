// SPDX-License-Identifier: AGPL-3.0-or-later
// Where repository commands run and how its files are reached. `local` runs commands directly;
// `wsl` runs them inside a WSL distribution via `wsl.exe --exec` (no shell, no quoting) and reaches
// files through the \\wsl.localhost\<distro> share. Environment variables never cross into WSL
// except the ones passed explicitly (WSLENV is not used), so provider secrets stay on the host.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runBounded, type RunResult } from '../util/proc.js';

export interface HostRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface Host {
  readonly kind: 'local' | 'wsl';
  /** Path module for repository-side paths. */
  readonly path: path.PlatformPath;
  run(cmd: string, args: string[], opts: HostRunOptions): Promise<RunResult>;
  /** Translate a repository-side path into one Node's fs can open. */
  fsPath(p: string): string;
  exists(p: string): boolean;
  /** Canonical repository-side path (resolves symlinks; tolerates missing leaf). */
  realpath(p: string): Promise<string>;
}

export class LocalHost implements Host {
  readonly kind = 'local' as const;
  readonly path = path;
  run(cmd: string, args: string[], o: HostRunOptions) {
    return runBounded(cmd, args, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, signal: o.signal, stdin: o.stdin, maxOutputBytes: o.maxOutputBytes });
  }
  fsPath(p: string) {
    return p;
  }
  exists(p: string) {
    return existsSync(p);
  }
  async realpath(p: string) {
    const { realpathSync } = await import('node:fs');
    let cur = path.resolve(p);
    const tail: string[] = [];
    while (!existsSync(cur)) {
      tail.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    return path.join(realpathSync(cur), ...tail);
  }
}

export class WslHost implements Host {
  readonly kind = 'wsl' as const;
  readonly path = path.posix;
  constructor(readonly distro: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(distro)) throw new Error(`invalid WSL distro name ${distro}`);
  }

  run(cmd: string, args: string[], o: HostRunOptions) {
    const secs = Math.max(1, Math.ceil(o.timeoutMs / 1000));
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`);
    // Have Linux stop its own command group before the orchestrator reuses the worktree.
    const cancelOnStdin = !!o.signal && o.stdin === undefined;
    const command = ['timeout', '-k', '10', String(secs), cmd, ...args];
    const wslArgs = ['-d', this.distro, '--cd', o.cwd, '--exec', 'env', ...env,
      ...(cancelOnStdin ? ['bash', '-c', CANCEL_WSL_COMMAND, 'orch-wsl', ...command] : command)];
    return runBounded('wsl.exe', wslArgs, {
      cwd: process.cwd(), stdin: o.stdin, signal: o.signal, maxOutputBytes: o.maxOutputBytes, cancelOnStdin,
      timeoutMs: o.timeoutMs + 20_000,
    });
  }

  fsPath(p: string) {
    if (!p.startsWith('/')) throw new Error(`WSL paths must be absolute: ${p}`);
    return `\\\\wsl.localhost\\${this.distro}${p.replace(/\//g, '\\')}`;
  }

  exists(p: string) {
    return existsSync(this.fsPath(p));
  }

  async realpath(p: string) {
    const r = await this.run('realpath', ['-m', '--', p], { cwd: '/', timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`realpath failed for ${p}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }
}

const CANCEL_WSL_COMMAND = `
"$@" </dev/null &
command_pid=$!
exec 3<&0
(if IFS= read -r <&3; then kill -TERM "$command_pid" 2>/dev/null; fi) &
watcher_pid=$!
wait "$command_pid"
status=$?
kill "$watcher_pid" 2>/dev/null
wait "$watcher_pid" 2>/dev/null
exit "$status"
`;
