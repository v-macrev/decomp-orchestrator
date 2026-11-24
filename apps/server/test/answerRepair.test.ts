// SPDX-License-Identifier: AGPL-3.0-or-later
// What the orchestrator does itself between a worker's answer and the Gate Keeper: class declarations
// for the packet's own member functions, member and replace edits, origin labels in the repository's
// form, and unit views that keep the packet's class in sight.
import { describe, expect, it } from 'vitest';
import { declareMembers, memberDefs } from '../src/orchestrator/classDecls.js';
import { applyEdit, materialise } from '../src/orchestrator/edits.js';
import { repairLabels } from '../src/orchestrator/labelRepair.js';
import { expandElisions, focusFile } from '../src/orchestrator/unitView.js';

describe('class declarations', () => {
  const H = 'reconstruction/a/Foo.h';
  const C = 'reconstruction/a/Foo.cpp';
  const header = 'class Bar;\nclass Foo : public Bar\n{\npublic:\n    void Old();\nprivate:\n    int x;\n};\n';
  const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null;

  it('declares what the .cpp defines and the class lacks, publicly, and nothing twice', async () => {
    const cpp = '#include "Foo.h"\n\nvoid Foo::Old()\n{\n}\n\nstd::uint32_t* Foo::Get(const char* a, int b) const\n{\n    return nullptr;\n}\n';
    const r = await declareMembers([{ path: C, content: cpp }], [H, C], reader({ [H]: header }));
    const h = r.files.find((f) => f.path === H)!.content;
    expect(h).toContain('    int x;\npublic:\n    std::uint32_t* Get(const char* a, int b) const;\n};');
    expect(h.match(/Old\(/g)).toHaveLength(1);
    const again = await declareMembers(r.files, [H, C], reader({ [H]: header }));
    expect(again.changes).toEqual([]);
  });

  it('uses the class of the source itself, leaves classes of other headers alone, and respects isOwn', async () => {
    const own = 'struct Foo\n{\n    int x;\n};\n\nint Foo::Get()\n{\n    return x;\n}\n';
    const r = await declareMembers([{ path: C, content: own }], [H, C], reader({ [H]: header }));
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.content).toContain('    int x;\n    int Get();\n};');
    expect((await declareMembers([{ path: C, content: 'int Other::Get()\n{\n    return 1;\n}\n' }], [H, C], reader({ [H]: header }))).changes).toEqual([]);
    expect((await declareMembers([{ path: C, content: own }], [H, C], reader({}), () => false)).changes).toEqual([]);
    // A file outside the packet is never written.
    expect((await declareMembers([{ path: C, content: 'int Foo::Get()\n{\n    return 1;\n}\n' }], [C], reader({ [H]: header }))).changes).toEqual([]);
  });

  it('reads constructors, destructors and calls for what they are', () => {
    const src = 'Foo::Foo(int a) : Bar(a), x(a)\n{\n}\n\nFoo::~Foo()\n{\n    Bar::Run(1);\n    if (x) { Baz::Go(2); }\n}\n\nbool\nFoo::Is() const\n{\n    return true;\n}\n';
    expect(memberDefs(src).map((d) => d.decl).sort()).toEqual(['Foo(int a);', 'bool Is() const;', '~Foo();'].sort());
  });
});

describe('member and replace edits', () => {
  const src = '// h\n#pragma once\nclass Foo\n{\npublic:\n    void A();\n    std::uint8_t pad[0x10];\n};\n';

  it('adds members once, replaces text that occurs once, and reports what it cannot place', () => {
    const r = applyEdit(src, {
      path: 'Foo.h', functions: [], members: [{ class: 'Foo', code: 'void A();\nvoid B(int);' }],
      replace: [{ find: 'std::uint8_t  pad[0x10];', with: 'void* p;\n    std::uint8_t pad[0x8];' }],
    });
    expect(r.problems).toEqual([]);
    expect(r.content).toContain('    void* p;\n    std::uint8_t pad[0x8];\n    void B(int);\n};');
    expect(r.content.match(/void A\(\)/g)).toHaveLength(1);
    const bad = applyEdit(src, { path: 'Foo.h', functions: [], members: [{ class: 'Nope', code: 'int x;' }], replace: [{ find: 'int nothing;', with: 'x' }] });
    expect(bad.content).toBe(src);
    expect(bad.problems).toHaveLength(2);
    expect(applyEdit('int a;\nint a;\n', { path: 'x.h', functions: [], replace: [{ find: 'int a;', with: 'int b;' }] }).problems[0]).toContain('more than once');
  });
});

describe('members named under the wrong file', () => {
  it('go to the file of the pair that defines the class', async () => {
    const files: Record<string, string> = { 'a/Foo.h': 'class Foo\n{\npublic:\n    int x;\n};\n', 'a/Foo.cpp': '#include "Foo.h"\n' };
    const m = await materialise({ edits: [{ path: 'a/Foo.cpp', members: [{ class: 'Foo', code: 'int Get();' }], functions: [{ name: 'Foo::Get', code: 'int Foo::Get()\n{\n    return x;\n}' }] }] }, async (p) => files[p] ?? null);
    expect(m.problems).toEqual([]);
    expect(m.files.find((f) => f.path === 'a/Foo.h')!.content).toContain('    int x;\n    int Get();\n};');
  });
});

describe('origin labels', () => {
  const fix = (s: string, base: string | null = null, p = 'a/Foo.h') => repairLabels(p, s, base).content;

  it('names a nameless label after the declaration below it and turns trailing text into a note', () => {
    expect(fix('// STANDIN: global float read by Function64d3f0\nextern float gDefault;')).toBe('// gDefault: STANDIN GUESS(low); global float read by Function64d3f0\nextern float gDefault;');
    expect(fix('// GUESS(low): stores the flag.\nvoid Script::Set(bool a)\n{', null, 'a/Foo.cpp')).toBe('// Set: GUESS(low); stores the flag\nvoid Script::Set(bool a)\n{');
    expect(fix('// Callee names: GUESS(low), from the listing.')).toBe('// Callee names: GUESS(low); from the listing');
    expect(fix('// A: GUESS(low); B: GUESS(low)')).toBe('// A: GUESS(low)\n// B: GUESS(low)');
  });

  it('lifts a label from behind a header declaration, and keeps prose as prose', () => {
    expect(fix('    void* unk10; // 10, GUESS(low)')).toBe('    // unk10: GUESS(low)\n    void* unk10; // 10, guess(low)');
    expect(fix('    x = 1; // GUESS(low)', null, 'a/Foo.cpp')).toBe('    x = 1; // guess(low)');
    expect(fix('// STANDIN filler slots to place Unk_12')).toBe('// standin filler slots to place Unk_12');
    expect(fix('// Code origin: names invented (GUESS).')).toBe('// Code origin: names invented (guess).');
  });

  it('knows the newer labels and gives placeholder stand-ins their origin', () => {
    const ok = '// A: CRASHLOGGER_PDB(59818@1.2)\n// B: SYMBOLS(fo4-pdb) GUESS(low)\n// BSFixedString: STANDIN';
    expect(fix(ok)).toBe(ok);
    expect(fix('// Slot06..Slot17: STANDIN; placeholders for unknown slots')).toBe('// Slot06..Slot17: STANDIN GUESS(low); placeholders for unknown slots');
  });

  it('leaves valid labels and lines upstream already has alone', () => {
    const ok = '// A, B: COMMUNITY(powerof3/CommonLibSSE@654e55f, GPL-3.0); RVA 0x10\n// C: STANDIN GUESS(low)';
    expect(repairLabels('a/Foo.h', ok, null).changes).toEqual([]);
    expect(fix('// odd GUESS line', '// odd GUESS line\n')).toBe('// odd GUESS line');
    expect(fix('// SPDX-License-Identifier: MIT (CommonLibSSE-NG ...)')).toContain('full text: licenses/CommonLibSSE-NG.txt');
  });
});

describe('focused unit view', () => {
  const filler = (n: string) => `class ${n}\n{\npublic:\n${Array.from({ length: 40 }, (_, i) => `    void Method${i}();`).join('\n')}\n};\n`;
  const text = `// Source exposure: x\n#pragma once\n#include "a.h"\n\n// one\n${filler('One')}\n// two\n${filler('Two')}\nclass Base\n{\n    int z;\n};\n\nclass Actor : public Base\n{\npublic:\n    void Run();\n};\n`;

  it('keeps the packet class (last in the file) and its base, and hides unrelated classes behind markers', () => {
    const v = focusFile('a/Actor.h', text, 300, new Set(['Actor']), new Set());
    expect(v.text).toContain('class Actor : public Base');
    expect(v.text).toContain('class Base');
    expect(v.text).not.toContain('class One');
    expect(v.text).toMatch(/\/\/ \[elided #1: \d+ lines declaring One, Two; kept verbatim, keep this line\]/);
    expect(focusFile('a/Actor.h', text, 100_000, new Set(['Actor']), new Set()).text).toBe(text);
  });

  it('gives a returned file its hidden declarations back, and refuses one that lost them', async () => {
    const v = focusFile('a/Actor.h', text, 300, new Set(['Actor']), new Set());
    expect(expandElisions('a/Actor.h', v.text, v.elisions)).toEqual({ content: text, missing: [] });
    const lost = v.text.split('\n').filter((l) => !l.includes('[elided')).join('\n');
    const m = await materialise({ files: [{ path: 'a/Actor.h', content: lost }] }, async () => text, v.elisions);
    expect(m.problems[0]).toContain('One, Two');
    const edit = await materialise({ edits: [{ path: 'a/Actor.h', functions: [], members: [{ class: 'Actor', code: 'int Go();' }] }] }, async () => text, v.elisions);
    expect(edit.problems).toEqual([]);
    expect(edit.files[0]!.content).toContain('class One');
    expect(edit.files[0]!.content).toContain('    void Run();\n    int Go();\n};');
  });
});
