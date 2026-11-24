// SPDX-License-Identifier: AGPL-3.0-or-later
// The claim issue a submitted PR opens, run against a stand-in for the project's own tools (no network).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAIM_PUBLISH_PY } from '../src/repo/srRepo.js';

const CONTRIB = `
B = 'b1'
DATA = {'functions': [
    {'build_id': B, 'rva': 0x1000, 'name': 'Alpha::One', 'status': 'unmatched'},
    {'build_id': B, 'rva': 0x3000, 'name': None, 'status': 'unmatched'}]}
class Stop(Exception): pass
class Gh:
    def user(self): return 'me'
    def create_issue(self, title, text): return 'https://github.com/x/y/issues/1'
class Ctx:
    repo = '.'
    def __init__(self, as_json): pass
    def github(self): return Gh()
def inventory(repo): return DATA
def local_claims(ctx): return {}
def save_local_claim(ctx, rva, row): pass
def claim_selection(ctx, args, data):
    rvas = sorted(int(r, 16) for r in args.rva)
    known = {f['rva']: f for f in DATA['functions']}
    # A function of the published list: no inventory entry yet.
    return [known.get(r) or {'build_id': B, 'rva': r, 'name': None, 'status': 'unmatched'} for r in rvas], [(r, r + 1) for r in rvas]
class batch_claims:
    @staticmethod
    def git_json(repo): return DATA
    @staticmethod
    def parts(build, entries, public, me, counts=None):
        import json, sys
        names = {f['rva']: f['name'] for f in public['functions']}
        sys.stderr.write(json.dumps({'total': sum(counts.values()), 'names': [names.get(a) for a, _ in entries], 'rows': len(public['functions'])}))
        return [('t', 'x', entries)]
`;
const python = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8' }).stdout?.trim() === '1');

describe.skipIf(!python)('the claim issue of a PR', () => {
  it('counts and names every function of the PR, also those the inventory does not have yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'claim-'));
    try {
      mkdirSync(join(root, 'tools'));
      writeFileSync(join(root, 'tools', 'contrib.py'), CONTRIB);
      const arg = { rvas: ['0x1000', '0x2000', '0x3000'], pr: 'https://github.com/x/y/pull/2', names: { '0x1000': 'Ours::One', '0x2000': 'Beta::Two', '0x3000': 'Gamma::Three' } };
      const r = spawnSync(python!, ['-c', CLAIM_PUBLISH_PY, JSON.stringify(arg)], { cwd: root, encoding: 'utf8' });
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, urls: ['https://github.com/x/y/issues/1'] });
      // The inventory's own name stays where it has one.
      expect(JSON.parse(r.stderr)).toEqual({ total: 3, names: ['Alpha::One', 'Beta::Two', 'Gamma::Three'], rows: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
