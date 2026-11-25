// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the reconstruction engine as one bounded process per request, through the same Host the repository
// adapter uses (local or WSL: time-bounded, scrubbed environment, cancellable, process tree killed on abort).
// There is no daemon, no socket and no network (docs/recon/ARCHITECTURE.md, process view).
//
// Anything but exactly one valid result is an *infrastructure* failure: it is reported as such and the
// caller never charges it to the packet, never counts a strike and never ends the run
// (docs/recon/INTEGRATION_CONTRACT.md, outcome mapping).
import path from 'node:path';
import { z } from 'zod';
import type { Host } from '../repo/host.js';
import { EngineProgress, EngineRequest, EngineResult, MAX_LINE_BYTES } from './protocol.js';

export type InfraKind = 'spawn' | 'timeout' | 'aborted' | 'exit' | 'no-result' | 'malformed' | 'mismatch';

export type EngineRun =
  | { ok: true; result: EngineResult; progress: EngineProgress[]; durationMs: number }
  | { ok: false; kind: InfraKind; detail: string; progress: EngineProgress[]; durationMs: number };

export interface EngineProcessOptions {
  host: Host;
  /** Directory holding `recon/` (the engine package), as the host sees it. */
  engineDir: string;
  /** The interpreter and its arguments; the default runs the engine package (`python3 -s -B -m recon serve`). */
  python?: string;
  args?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

/** A Windows path as the WSL distribution sees it (`D:\a\b` -> `/mnt/d/a/b`); other paths pass through. */
export function toHostPath(host: Host, p: string): string {
  if (host.kind !== 'wsl') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

/** The engine package of this repository, as `host` sees it. */
export function defaultEngineDir(host: Host, repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')): string {
  return toHostPath(host, path.join(repoRoot, 'engine', 'recon'));
}

const bound = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Parse the engine's stdout: progress lines, then exactly one result line. */
export function parseEngineOutput(stdout: string, request: EngineRequest): { ok: true; result: EngineResult; progress: EngineProgress[] } | { ok: false; kind: InfraKind; detail: string; progress: EngineProgress[] } {
  const progress: EngineProgress[] = [];
  let result: EngineResult | null = null;
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (const [i, line] of lines.entries()) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return { ok: false, kind: 'malformed', detail: `line ${i + 1} exceeds the size limit`, progress };
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, kind: 'malformed', detail: `line ${i + 1} is not JSON`, progress };
    }
    if (result) return { ok: false, kind: 'malformed', detail: 'a line follows the result', progress };
    const type = (json as { type?: unknown } | null)?.type;
    if (type === 'progress') {
      const p = EngineProgress.safeParse(json);
      if (!p.success) return { ok: false, kind: 'malformed', detail: `line ${i + 1}: ${bound(zodIssues(p.error))}`, progress };
      progress.push(p.data);
    } else if (type === 'result') {
      const r = EngineResult.safeParse(json);
      if (!r.success) return { ok: false, kind: 'malformed', detail: `line ${i + 1}: ${bound(zodIssues(r.error))}`, progress };
      result = r.data;
    } else {
      return { ok: false, kind: 'malformed', detail: `line ${i + 1} has no known type`, progress };
    }
  }
  if (!result) return { ok: false, kind: 'no-result', detail: 'the engine exited without a result line', progress };
  if (result.requestId !== request.requestId || result.command !== request.command) {
    return { ok: false, kind: 'mismatch', detail: 'the result answers another request', progress };
  }
  const asked = new Set(request.packet?.functions.map((f) => f.rva) ?? []);
  const got = result.functions.map((f) => f.rva);
  if (request.command === 'solve' && (got.length !== asked.size || got.some((r) => !asked.has(r)) || new Set(got).size !== got.length)) {
    return { ok: false, kind: 'mismatch', detail: 'the result does not cover exactly the packet\'s functions', progress };
  }
  if (result.edits.length && !result.functions.some((f) => f.status === 'solved')) {
    return { ok: false, kind: 'mismatch', detail: 'edits without a solved function', progress };
  }
  return { ok: true, result, progress };
}

function zodIssues(e: z.ZodError): string {
  return e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ');
}

export async function runEngine(request: EngineRequest, o: EngineProcessOptions): Promise<EngineRun> {
  const checked = EngineRequest.safeParse(request);
  if (!checked.success) throw new Error(`invalid engine request: ${zodIssues(checked.error)}`); // a defect of the caller
  const started = Date.now();
  let r;
  try {
    r = await o.host.run(o.python ?? 'python3', o.args ?? ['-s', '-B', '-m', 'recon', 'serve'], {
      cwd: o.engineDir,
      env: { PYTHONPATH: o.engineDir, PYTHONHASHSEED: '0', PYTHONDONTWRITEBYTECODE: '1' },
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      stdin: JSON.stringify(checked.data) + '\n',
      maxOutputBytes: MAX_LINE_BYTES * 2,
    });
  } catch (e) {
    return { ok: false, kind: 'spawn', detail: bound((e as Error).message), progress: [], durationMs: Date.now() - started };
  }
  const durationMs = r.durationMs ?? Date.now() - started;
  const partial = parseEngineOutput(r.stdout, checked.data);
  const progress = partial.progress;
  if (r.aborted) return { ok: false, kind: 'aborted', detail: 'cancelled', progress, durationMs };
  if (r.timedOut) return { ok: false, kind: 'timeout', detail: `no result within ${Math.round(o.timeoutMs / 1000)}s`, progress, durationMs };
  if (r.truncated) return { ok: false, kind: 'malformed', detail: 'output exceeded the limit', progress, durationMs };
  if (r.code !== 0) return { ok: false, kind: 'exit', detail: `exit ${r.code}: ${bound(r.stderr)}`, progress, durationMs };
  if (!partial.ok) return { ok: false, kind: partial.kind, detail: partial.detail, progress, durationMs };
  return { ok: true, result: partial.result, progress, durationMs };
}
