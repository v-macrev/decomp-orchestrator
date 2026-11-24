// SPDX-License-Identifier: AGPL-3.0-or-later
// Rebuilding a set-aside unit on upstream's current files (synthetic units only).
import { describe, expect, it } from 'vitest';
import { removeFunctions, spliceUnit, stillDefines } from '../src/orchestrator/splice.js';

const CPP = 'reconstruction/a/Widget.cpp';
const H = 'reconstruction/a/Widget.h';

// Upstream matched Widget::Width (someone else's body) since our unit was drafted.
const UP_CPP = [
  '// Source exposure: public.',
  '// Code origin: original; upstream contributor',
  '// 0x100 Widget::Width',
  '#include "Widget.h"',
  '',
  'int Widget::Width() const',
  '{',
  '    return w;',
  '}',
  '',
].join('\n');
const UP_H = ['#pragma once', '// Widget: GUESS(low)', 'class Widget', '{', 'public:', '    int Width() const;', '    int w;', '};', ''].join('\n');

const OURS_CPP = [
  '// Source exposure: public.',
  '// Code origin: original; drafted from the listing',
  '// 0x100 Widget::Width',
  '// 0x120 Widget::Height',
  '// 0x140 Widget::Gone',
  '#include "Widget.h"',
  '#include <cstdint>',
  '',
  'extern int g_scale;',
  '',
  'int Widget::Width() const { return w + 0; }',
  '',
  'int Widget::Height() const',
  '{',
  '    return h * g_scale;',
  '}',
  '',
  'void Widget::Gone() { }',
  '',
].join('\n');
// One-line class, as the workers often write it.
const OURS_H = ['#pragma once', '// Widget, Height: GUESS(low)', 'class Widget { public: int Width() const; int Height() const; void Gone(); int w; int h; };', ''].join('\n');

const fn = (rva: string, name: string) => ({ rva, name, size: 8 });

describe('taking functions out of a stored candidate', () => {
  it('removes the definition, its own comment and its marker line, and nothing else', () => {
    const src = OURS_CPP.replace('int Widget::Height() const\n', '// Scaled height.\nint Widget::Height() const\n');
    const out = removeFunctions(src, [fn('0x120', 'Widget::Height'), fn('0x999', 'Widget::Absent')]);
    expect(out).not.toMatch(/Height|Scaled|0x120/);
    expect(out).toContain('// Code origin: original; drafted from the listing');
    expect(out).toContain('// 0x100 Widget::Width');
    expect(out).toContain('int Widget::Width() const { return w + 0; }');
    expect(out).toContain('void Widget::Gone() { }');
    const ctor = 'A::A(int n)\n    : m(n)\n{\n    Init();\n}\n\nvoid A::Init()\n{\n}\n';
    expect(removeFunctions(ctor, [fn('0x2', 'A::A')])).toBe('\nvoid A::Init()\n{\n}\n');
    expect(stillDefines(ctor, [fn('0x3', 'A::Init')])).toBe(true);
    expect(stillDefines(removeFunctions(ctor, [fn('0x3', 'A::Init')]), [fn('0x3', 'A::Init')])).toBe(false); // the call in A::A is no definition
    // A comment block that is the file's header stays.
    expect(removeFunctions('// Source exposure: public.\nvoid A::B()\n{\n}\n', [fn('0x1', 'A::B')])).toBe('// Source exposure: public.\n');
  });
});

describe('rebuild on upstream', () => {
  const r = spliceUnit({
    cpp: CPP,
    ours: new Map([[CPP, OURS_CPP], [H, OURS_H]]),
    upstream: new Map([[CPP, UP_CPP], [H, UP_H]]),
    keep: [fn('0x120', 'Widget::Height')],
    drop: [fn('0x100', 'Widget::Width'), fn('0x140', 'Widget::Gone')],
  });
  const cpp = r.files.find((f) => f.path === CPP)!.content;
  const h = r.files.find((f) => f.path === H)!.content;

  it("keeps upstream's matched body and adds only the functions nobody else has", () => {
    expect(cpp).toContain('    return w;\n}');
    expect(cpp).not.toContain('return w + 0;');
    expect(cpp).toContain('int Widget::Height() const\n{\n    return h * g_scale;\n}');
    expect(cpp).not.toContain('Widget::Gone');
  });

  it('carries the header line, the includes and the declarations the body needs', () => {
    expect(cpp).toMatch(/\/\/ 0x100 Widget::Width\n\/\/ 0x120 Widget::Height\n#include "Widget.h"\n#include <cstdint>/);
    expect(cpp).toContain('extern int g_scale;');
    expect(cpp).not.toContain('0x140');
  });

  it('declares the function in the class and labels it', () => {
    expect(h).toContain('    int Width() const;');
    expect(h).toMatch(/public:\n {4}int Width\(\) const;\n {4}int w;\n {4}int Height\(\) const;\n};/);
    expect(h).toContain('// Height: GUESS(low)');
    expect(h).not.toContain('Gone');
  });

  it('keeps our unit, minus the dropped functions, when upstream has no such unit', () => {
    const only = spliceUnit({ cpp: CPP, ours: new Map([[CPP, OURS_CPP], [H, OURS_H]]), upstream: new Map([[CPP, null], [H, null]]), keep: [fn('0x120', 'Widget::Height')], drop: [fn('0x140', 'Widget::Gone')] });
    const c = only.files.find((f) => f.path === CPP)!.content;
    expect(c).toContain('Widget::Height() const');
    expect(c).not.toContain('Widget::Gone');
    expect(c).not.toContain('0x140');
  });

  it('carries the members, types and helpers the bodies use, and nothing else', () => {
    const ours = [
      '#include "T.h"', '', 'void Tail(void* a, Topic* self);', 'struct Single { int pad[4]; void* value; };', 'static Single** g_single;',
      'struct Unused', '{', '    int x;', '};', 'void Topic::A(void* v)', '{', '    ptr38 = v;', '    return Tail((*g_single)->value, this);', '}',
      'void Topic::B()', '{', '    other = 0;', '}', '',
    ].join('\n');
    const oursH = [
      '// Topic: EXE_RTTI', '// ptr38, Holder: GUESS(low); invented', '#pragma once', '#include <cstdint>', 'class Holder', '{', 'public:', '    virtual int Get();', '};', 'class Spare;',
      'class Topic', '{', 'public:', '    virtual int GetType() const;', '    void A(void* v);', '    void B();', 'private:', '    std::uint8_t unk08[0x30];', '    void* ptr38;', '    Holder* other;', '};', '',
    ].join('\n');
    const upCpp = ['// 0x1 Topic::GetType', '#include "T.h"', 'int Topic::GetType() const', '{', '    return 1;', '}', ''].join('\n');
    const upH = ['// Topic: EXE_RTTI', '#pragma once', '#include <cstdint>', 'class Topic', '{', 'public:', '    virtual int GetType() const;', '};', ''].join('\n');
    const go = (header: string) => spliceUnit({ cpp: 'T.cpp', ours: new Map([['T.cpp', ours], ['T.h', oursH]]), upstream: new Map([['T.cpp', upCpp], ['T.h', header]]), keep: [fn('0x2', 'Topic::A')], drop: [fn('0x3', 'Topic::B')] }).files;
    const [c, hh] = go(upH).map((f) => f.content) as [string, string];
    expect(c).toContain('void Tail(void* a, Topic* self);\nstruct Single { int pad[4]; void* value; };\nstatic Single** g_single;\n\nvoid Topic::A');
    expect(c).not.toMatch(/Unused|Topic::B/);
    expect(hh).toMatch(/class Holder\n\{\npublic:\n {4}virtual int Get\(\);\n\};\n\nclass Topic\n\{\npublic:\n {4}virtual int GetType\(\) const;\n {4}void A\(void\* v\);\n {4}std::uint8_t unk08\[0x30\];\n {4}void\* ptr38;\n {4}Holder\* other;\n\};/);
    expect(hh).toContain('// ptr38, Holder: GUESS(low); invented');
    expect(hh).not.toContain('Spare');
    // A class that has members of its own keeps exactly them.
    const own = go(upH.replace('() const;\n}', '() const;\n    int mine;\n}'))[1]!.content;
    expect(own).toContain('    int mine;');
    expect(own).not.toContain('ptr38;');
  });

  it('leaves a function upstream already defines alone', () => {
    const same = spliceUnit({ cpp: CPP, ours: new Map([[CPP, OURS_CPP], [H, OURS_H]]), upstream: new Map([[CPP, UP_CPP], [H, UP_H]]), keep: [fn('0x100', 'Widget::Width')], drop: [] });
    expect(same.files.find((f) => f.path === CPP)!.content.match(/Widget::Width\(\) const/g)).toHaveLength(1);
    expect(same.notes.join(' ')).toMatch(/upstream already defines it/);
  });
});
