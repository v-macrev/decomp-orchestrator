// SPDX-License-Identifier: AGPL-3.0-or-later
// Rebuilding a set-aside unit on upstream's current files (synthetic units only).
import { describe, expect, it } from 'vitest';
import { spliceUnit } from '../src/orchestrator/splice.js';

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
    expect(h).toMatch(/public:\n {4}int Height\(\) const;\n};/);
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

  it('leaves a function upstream already defines alone', () => {
    const same = spliceUnit({ cpp: CPP, ours: new Map([[CPP, OURS_CPP], [H, OURS_H]]), upstream: new Map([[CPP, UP_CPP], [H, UP_H]]), keep: [fn('0x100', 'Widget::Width')], drop: [] });
    expect(same.files.find((f) => f.path === CPP)!.content.match(/Widget::Width\(\) const/g)).toHaveLength(1);
    expect(same.notes.join(' ')).toMatch(/upstream already defines it/);
  });
});
