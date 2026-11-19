// SPDX-License-Identifier: AGPL-3.0-or-later
// Bounded child-process execution: hard wall-clock timeout with process-tree kill, output caps,
// confined cwd and an allowlisted environment (provider secrets never reach repo tooling).
import { spawn, spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Variables added on top of the scrubbed base environment. */
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes?: number;
  stdin?: string;
  signal?: AbortSignal;
  /** Pass the full parent env (only for trusted, non-repo commands such as git). */
  inheritEnv?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

/** Variables repo tooling legitimately needs. Everything else (API keys, tokens) is dropped. */
const ENV_ALLOW = [
  /^PATH$/i, /^PATHEXT$/i, /^SYSTEMROOT$/i, /^SYSTEMDRIVE$/i, /^WINDIR$/i, /^COMSPEC$/i,
  /^TEMP$/i, /^TMP$/i, /^TMPDIR$/, /^HOME$/, /^USERPROFILE$/i, /^HOMEDRIVE$/i, /^HOMEPATH$/i,
  /^APPDATA$/i, /^LOCALAPPDATA$/i, /^PROGRAMDATA$/i, /^PROGRAMFILES/i, /^NUMBER_OF_PROCESSORS$/i,
  /^PROCESSOR_ARCHITECTURE$/i, /^OS$/i, /^LANG$/, /^LC_/, /^TERM$/, /^SHELL$/, /^USER$/, /^USERNAME$/i, /^LOGNAME$/,
  /^WINE/, /^SR_/, /^PYTHONIOENCODING$/, /^PYTHONUTF8$/, /^GIT_CONFIG_NOSYSTEM$/,
];
const ENV_DENY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

export function scrubbedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_DENY.test(k)) continue;
    if (ENV_ALLOW.some((rx) => rx.test(k))) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  out.PYTHONIOENCODING = 'utf-8';
  out.PYTHONUTF8 = '1';
  return out;
}

function killTree(pid: number) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export function runBounded(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const max = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.inheritEnv ? { ...process.env, ...opts.env } : scrubbedEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group so we can kill the tree
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    const take = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > max) {
        truncated = true;
        if (child.pid) killTree(child.pid);
        return;
      }
      if (which === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, truncated, durationMs: Date.now() - started });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
