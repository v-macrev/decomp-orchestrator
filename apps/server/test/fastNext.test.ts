// SPDX-License-Identifier: AGPL-3.0-or-later
// The backlog scan's launcher, run against stand-ins for the project's own tools.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAST_NEXT_PY } from '../src/repo/srRepo.js';

const TOOLS: Record<string, string> = {
  'check_labels.py': `
calls = {'strip': 0, 'screen': 0, 'declaration': 0}
def strip(text):
    calls['strip'] += 1
    return text.upper()
def braces(text): return {0: len(text)}
def scope_matches(text):
    yield text
`,
  'contrib_screen.py': `
import check_labels
def screen(blob, name, *, headers=frozenset()):
    check_labels.calls['screen'] += 1
    return []
`,
  'contrib_readiness.py': `
import check_labels
def declaration(text, cls, method):
    check_labels.calls['declaration'] += 1
    clean = check_labels.strip(text)
    return [list(check_labels.scope_matches(clean)), check_labels.braces(clean)]
def readiness(method):
    from contrib_screen import screen
    screen(b'x', 'declarations.h')
    return declaration('void Get();', 'A', method)
`,
  'contrib.py': `
import json, sys
import check_labels, contrib_readiness, pdb_facts
class Ctx:
    def say(self, line): print('printed line')
def pdb_names(ctx): raise RuntimeError('names looked up')
def main(argv=None):
    ctx = Ctx()
    pdb_names(ctx)
    rows = [contrib_readiness.readiness(m) for m in ('Get', 'Get', 'Missing')]
    ctx.say(pdb_facts.brief('.', 1, 'x'))
    print(json.dumps({'argv': argv, 'rows': rows, 'calls': check_labels.calls}))
    return 3
`,
  'pdb_facts.py': `
def brief(repo, rva, name=None): raise RuntimeError('facts looked up')
`,
};
const python = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8' }).stdout?.trim() === '1');

function run(tools: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'next-'));
  try {
    mkdirSync(join(root, 'tools'));
    for (const [name, text] of Object.entries(tools)) writeFileSync(join(root, 'tools', name), text);
    return spawnSync(python!, ['-c', FAST_NEXT_PY, '--json', 'next', '--count', '9'], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!python)('the backlog scan', () => {
  it('passes the arguments and exit code on, parses each header once and prints only the result', () => {
    const r = run(TOOLS);
    expect(r.status).toBe(3);
    const hit = [['VOID GET();'], { 0: 11 }];
    expect(JSON.parse(r.stdout)).toEqual({ argv: ['--json', 'next', '--count', '9'], rows: [hit, hit, null], calls: { strip: 1, screen: 1, declaration: 2 } });
  });

  it('still runs when upstream has none of the helpers it speeds up', () => {
    const r = run({ 'contrib.py': "class Ctx: pass\ndef main(argv=None):\n    print('[]')\n    return 0\n" });
    expect([r.status, r.stdout.trim()]).toEqual([0, '[]']);
  });
});
