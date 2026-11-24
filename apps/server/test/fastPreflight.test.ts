// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate's preflight reads upstream's list of accepted functions once per base revision.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAST_PREFLIGHT_PY } from '../src/repo/srRepo.js';

const python = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8' }).stdout?.trim() === '1');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const CV = `
import json, pathlib
calls = [0]
def accepted_sources(root):
    calls[0] += 1
    for p in sorted(pathlib.Path(root, 'reports').glob('*.json')):
        yield {'rva': int(p.stem)}, json.loads(p.read_text())
`;
const CONTRIB = `
import json, contrib_validation as cv
def main(argv=None):
    a = [[f['rva'], s['compiled']] for f, s in cv.accepted_sources('.')]
    b = [s['compiled'] for f, s in cv.accepted_sources('.')]
    print(json.dumps({'argv': argv, 'a': a, 'b': b, 'calls': cv.calls[0]}))
    return 1
`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  const local = mkdtempSync(join(tmpdir(), 'pf-local-'));
  dirs.push(root, local);
  const put = (p: string, text: string) => writeFileSync(join(root, p), text);
  for (const d of ['tools', 'data', 'reports']) mkdirSync(join(root, d));
  put('tools/contrib.py', CONTRIB);
  put('tools/contrib_validation.py', CV);
  put('data/progress.json', '{}');
  put('reports/1.json', '{"compiled": "a.cpp"}');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  const commit = () => [git('add', '-A'), git('commit', '-qm', 'x')];
  git('init', '-q');
  put('.gitignore', '__pycache__/\n');
  commit();
  const run = () => {
    const r = spawnSync(python!, ['-c', FAST_PREFLIGHT_PY, '--json', 'preflight', 'x'], { cwd: root, encoding: 'utf8', env: { ...process.env, SR_LOCAL_DIR: local } });
    return { status: r.status, out: JSON.parse(r.stdout) as { argv: string[]; a: unknown[]; b: string[]; calls: number } };
  };
  const cached = () => readdirSync(join(local, 'orchestrator')).filter((f) => f.endsWith('.json'));
  return { put, commit, run, cached };
}

describe.skipIf(!python)('the gate preflight', () => {
  it('gives the same answers, reads the list once, and keeps it for the next run of the same revision', () => {
    const r = repo();
    expect(r.run()).toEqual({ status: 1, out: { argv: ['--json', 'preflight', 'x'], a: [[1, 'a.cpp']], b: ['a.cpp'], calls: 1 } });
    expect(r.run().out).toMatchObject({ a: [[1, 'a.cpp']], calls: 0 });
    expect(r.cached()).toHaveLength(1);
  });

  it('reads it again after the reports change, and never keeps a list of uncommitted reports', () => {
    const r = repo();
    r.run();
    r.put('reports/2.json', '{"compiled": "b.cpp"}');
    expect(r.run().out).toMatchObject({ b: ['a.cpp', 'b.cpp'], calls: 1 });
    expect(r.run().out).toMatchObject({ b: ['a.cpp', 'b.cpp'], calls: 1 });
    r.commit();
    expect(r.run().out).toMatchObject({ b: ['a.cpp', 'b.cpp'], calls: 1 });
    expect(r.run().out).toMatchObject({ b: ['a.cpp', 'b.cpp'], calls: 0 });
    expect(r.cached()).toHaveLength(1);
  });

  it('still runs when upstream has no such helper', () => {
    const r = repo();
    r.put('tools/contrib_validation.py', '');
    r.put('tools/contrib.py', "def main(argv=None):\n    print('{}')\n    return 0\n");
    expect(r.run()).toEqual({ status: 0, out: {} });
  });
});
