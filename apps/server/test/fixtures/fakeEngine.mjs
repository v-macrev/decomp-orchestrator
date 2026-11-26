// SPDX-License-Identifier: AGPL-3.0-or-later
// A stand-in engine process for server tests: reads one request line and misbehaves as options.mode says.
// With `--request FILE` it reads the request from that file, as the deterministic tier sends it.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

let input = '';
const at = process.argv.indexOf('--request');
if (at > 0) {
  input = readFileSync(process.argv[at + 1], 'utf8');
} else {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
}
const req = JSON.parse(input.split('\n')[0]);
// Tests that look at what the tier sent read this log (one request per line).
if (req.dataDir) appendFileSync(`${req.dataDir}/requests.log`, JSON.stringify(req) + '\n');
const m = process.argv.indexOf('--mode');
const mode = m > 0 ? process.argv[m + 1] : (req.options?.mode ?? 'ok');
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
} else if (mode === 'sim' || mode === 'sim-wrong') {
  // Simulator packets: functions whose RVA hashes to an even first digit are "solved" with the simulator's answer
  // (`sim-wrong` answers them wrongly, to show that the Gate Keeper still decides).
  const hex = (s) => createHash('sha256').update(s).digest('hex');
  const ident = (f) => (f.name ?? `Fn_${f.rva}`).replace(/::/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
  const solved = req.packet.functions.filter((f) => parseInt(hex(`solve:${f.rva}`)[0], 16) % 2 === 0);
  const cpp = req.packet.allowedPaths.find((p) => p.endsWith('.cpp'));
  out(base({
    functions: req.packet.functions.map((f) => (solved.includes(f) ? fn(f, 'solved', 'BYTE_MATCHED') : fn(f, 'unsolved', 'CALLEE_SIGNATURE_UNKNOWN'))),
    edits: solved.length ? [{ path: cpp, functions: solved.map((f) => ({ name: ident(f), code: `int ${ident(f)}()\n{\n${mode === 'sim' ? `return 0x${hex(f.rva).slice(0, 6)};` : 'return 0;'}\n}` })) }] : [],
    ...(solved.length ? { codeOrigin: 'produced by a deterministic reconstruction tool', adaptedBodies: 'none' } : {}),
  }));
} else {
  out(base());
}
