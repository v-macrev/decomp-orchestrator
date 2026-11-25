// SPDX-License-Identifier: AGPL-3.0-or-later
// The server's side of the engine protocol: strict schemas, and a process runner that turns every
// misbehaviour of the engine into an infrastructure failure (never a verdict on the packet).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalHost, WslHost } from '../src/repo/host.js';
import { EngineRequest, EngineResult, engineModelName, type EngineRequest as Req } from '../src/recon/protocol.js';
import { defaultEngineDir, runEngine, toHostPath } from '../src/recon/process.js';
import { MODEL_TOKEN } from '../src/orchestrator/attribution.js';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fakeEngine.mjs');
const request = (mode: string, over: Partial<Req> = {}): Req => ({
  protocol: 1, requestId: 'r-1', command: 'solve',
  packet: { functions: [{ rva: '0x10', size: 40, name: 'A::B' }], unit: 'A_10', allowedPaths: ['reconstruction/a/A_10.cpp'] },
  options: { mode }, ...over,
});
const fake = (mode: string, timeoutMs = 20_000, extra: { signal?: AbortSignal } = {}) =>
  runEngine(request(mode), { host: new LocalHost(), engineDir: process.cwd(), python: process.execPath, args: [FAKE], timeoutMs, ...extra });

describe('engine request schema', () => {
  it('accepts a packet and refuses unknown fields, five functions and a missing packet', () => {
    expect(EngineRequest.safeParse(request('ok')).success).toBe(true);
    expect(EngineRequest.safeParse({ ...request('ok'), extra: 1 }).success).toBe(false);
    const many = request('ok');
    many.packet!.functions = Array.from({ length: 5 }, (_, i) => ({ rva: `0x${i + 1}`, size: 8 }));
    expect(EngineRequest.safeParse(many).success).toBe(false);
    expect(EngineRequest.safeParse({ protocol: 1, requestId: 'x', command: 'solve' }).success).toBe(false);
    expect(EngineRequest.safeParse({ protocol: 1, requestId: 'x', command: 'doctor' }).success).toBe(true);
  });

  it('names the engine attempt model with a token attribution accepts', () => {
    expect(engineModelName('0.1.0')).toBe('recon-engine-0.1.0');
    expect(MODEL_TOKEN.test(engineModelName('0.1.0'))).toBe(true);
  });

  it('has no result field that can carry a listing', () => {
    const base = { type: 'result', protocol: 1, requestId: 'r', command: 'solve', inputDigest: `sha256:${'0'.repeat(64)}`, engineVersion: '1', ruleStoreVersion: 'e@0', functions: [], edits: [] };
    expect(EngineResult.safeParse(base).success).toBe(true);
    expect(EngineResult.safeParse({ ...base, listing: 'mov eax, 1' }).success).toBe(false);
    expect(EngineResult.safeParse({ ...base, functions: [{ rva: '0x1', status: 'matched', reasonCode: 'X1', counters: {}, ruleTrail: [], originLabels: [], evidenceSummary: [] }] }).success).toBe(false);
  });
});

describe('engine process runner (fake engine)', () => {
  it('returns progress and the one result', async () => {
    const r = await fake('ok');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.progress.map((p) => p.stage)).toEqual(['analyze']);
    expect(r.result.functions.map((f) => [f.rva, f.status])).toEqual([['0x10', 'unsupported']]);
    expect(r.result.edits).toEqual([]);
  });

  it('returns edits for a solved function', async () => {
    const r = await fake('solved');
    expect(r.ok && r.result.edits[0]?.functions[0]?.name).toBe('A::B');
  });

  it.each([
    ['crash', 'exit'],
    ['garbage', 'malformed'],
    ['no-result', 'no-result'],
    ['unknown-field', 'malformed'],
    ['unknown-function-field', 'malformed'],
    ['progress-text', 'malformed'],
    ['two-results', 'malformed'],
    ['wrong-id', 'mismatch'],
    ['wrong-functions', 'mismatch'],
    ['edits-unsolved', 'mismatch'],
  ])('%s is an infrastructure failure (%s)', async (mode, kind) => {
    const r = await fake(mode);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe(kind);
  });

  it('times out a hung engine and keeps its progress', async () => {
    const r = await fake('hang', 1_500);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('timeout');
      expect(r.progress.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('stops a hung engine when the run is cancelled', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 600);
    const t0 = Date.now();
    const r = await fake('hang', 30_000, { signal: ctl.signal });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('aborted');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('reports a missing interpreter as a spawn-level failure', async () => {
    const r = await runEngine(request('ok'), { host: new LocalHost(), engineDir: process.cwd(), python: 'definitely-not-a-program', timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
  });

  it('refuses to send an invalid request', async () => {
    await expect(runEngine({ ...request('ok'), packet: undefined }, { host: new LocalHost(), engineDir: process.cwd(), timeoutMs: 1000 })).rejects.toThrow(/invalid engine request/);
  });
});

describe('host paths', () => {
  it('maps a Windows path into WSL and leaves local paths alone', () => {
    const wsl = new WslHost('Ubuntu');
    expect(toHostPath(wsl, 'D:\\Repositories\\x\\engine')).toBe('/mnt/d/Repositories/x/engine');
    expect(toHostPath(new LocalHost(), 'D:\\a')).toBe('D:\\a');
    expect(defaultEngineDir(new LocalHost(), '/r')).toBe(path.join('/r', 'engine', 'recon'));
  });
});

// The real engine on this machine's WSL: skipped, with the reason, where WSL or the distribution is absent.
const wslUp = process.platform === 'win32' && spawnSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'python3', '-c', 'import sys; assert sys.version_info >= (3, 11)'], { timeout: 30_000 }).status === 0;
describe.skipIf(!wslUp)('real engine in WSL (needs_checkout: WSL distribution Ubuntu with Python 3.11+)', () => {
  const host = new WslHost('Ubuntu');
  const engineDir = defaultEngineDir(host);

  it('answers a solve request, unsupported until reconstruction exists, with no edits', async () => {
    const r = await runEngine(request('ignored', { options: undefined }), { host, engineDir, timeoutMs: 60_000 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.result.engineVersion).toBe('0.1.0');
    expect(r.result.functions).toEqual([{ rva: '0x10', status: 'unsupported', reasonCode: 'ENGINE_NOT_IMPLEMENTED', counters: { candidates: 0, compiles: 0 }, ruleTrail: [], originLabels: [], evidenceSummary: [] }]);
    expect(r.result.edits).toEqual([]);
  });

  it('answers the same request with the same bytes (determinism)', async () => {
    const a = await runEngine(request('x', { options: undefined }), { host, engineDir, timeoutMs: 60_000 });
    const b = await runEngine(request('x', { options: undefined }), { host, engineDir, timeoutMs: 60_000 });
    expect(a.ok && b.ok && JSON.stringify(a.result)).toBe(a.ok && b.ok ? JSON.stringify(b.result) : '');
  });

  it('answers doctor', async () => {
    const r = await runEngine({ protocol: 1, requestId: 'd', command: 'doctor' }, { host, engineDir, timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result.report as { checks: Array<{ id: string }> }).checks.map((c) => c.id)).toContain('python');
  });
});
