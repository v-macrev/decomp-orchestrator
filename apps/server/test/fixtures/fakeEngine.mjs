// SPDX-License-Identifier: AGPL-3.0-or-later
// A stand-in engine process for server tests: reads one request line and misbehaves as options.mode says.
import { createHash } from 'node:crypto';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input.split('\n')[0]);
const mode = req.options?.mode ?? 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const digest = 'sha256:' + createHash('sha256').update(input).digest('hex');
const fn = (f, status = 'unsupported', reasonCode = 'ENGINE_NOT_IMPLEMENTED') => ({ rva: f.rva, status, reasonCode, counters: { candidates: 0 }, ruleTrail: [], originLabels: [], evidenceSummary: [] });
const base = (over = {}) => ({
  type: 'result', protocol: 1, requestId: req.requestId, command: req.command, inputDigest: digest,
  engineVersion: '0.0.0-fake', ruleStoreVersion: 'empty@0',
  functions: (req.packet?.functions ?? []).map((f) => fn(f)), edits: [], ...over,
});

if (mode === 'crash') { process.stderr.write('boom'); process.exit(7); }
if (mode === 'hang') { out({ type: 'progress', protocol: 1, stage: 'analyze', counters: {} }); setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === 'garbage') { process.stdout.write('this is not json\n'); process.exit(0); }
if (mode === 'no-result') { out({ type: 'progress', protocol: 1, stage: 'analyze', counters: { functions: 1 } }); process.exit(0); }
if (mode === 'unknown-field') { out(base({ listing: 'mov eax, 1' })); process.exit(0); }
if (mode === 'unknown-function-field') { const r = base(); r.functions[0].bytes = '48 89'; out(r); process.exit(0); }
if (mode === 'progress-text') { out({ type: 'progress', protocol: 1, stage: 'analyze', counters: {}, note: 'text' }); process.exit(0); }
if (mode === 'two-results') { out(base()); out(base()); process.exit(0); }
if (mode === 'wrong-id') { out(base({ requestId: 'someone-else' })); process.exit(0); }
if (mode === 'wrong-functions') { out(base({ functions: [fn({ rva: '0x999' })] })); process.exit(0); }
if (mode === 'edits-unsolved') { out(base({ edits: [{ path: req.packet.allowedPaths[0], functions: [{ name: 'A::B', code: 'int A::B() { return 1; }' }] }] })); process.exit(0); }
out({ type: 'progress', protocol: 1, stage: 'analyze', counters: { functions: req.packet?.functions.length ?? 0 } });
if (mode === 'solved') {
  out(base({
    functions: req.packet.functions.map((f) => fn(f, 'solved', 'BYTE_MATCHED')),
    edits: [{ path: req.packet.allowedPaths[0], functions: [{ name: 'A::B', code: 'int A::B() { return 1; }' }] }],
  }));
} else {
  out(base());
}
