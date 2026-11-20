// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { coAuthorTrailers, draftedByText, listModels, personOf, setDraftedBy } from '../src/orchestrator/attribution.js';
import { repairAnswer } from '../src/orchestrator/headerRepair.js';
import { cheatScan } from '../src/gatekeeper/rules.js';

const SKELETON = [
  '// TESObjectARMO functions for build sse-steam-1-7-104.',
  '// Source exposure: mixed (community headers; the pinned image listing).',
  '// Code origin: written for this reconstruction from the listing.',
  '// Drafted by decomp-orchestrator test, starting from',
  '// a tools/skeleton.py skeleton.',
  '// 0x27edf0 TESObjectARMO::GetSkill',
  '#include "TESObjectARMO.h"',
  '',
  'int TESObjectARMO::GetSkill() { return 0; }',
  '',
].join('\n');

describe('attribution text', () => {
  it('follows the contributors\' "<person>, assisted by <model>" form', () => {
    expect(draftedByText('v-macrev', ['claude-opus-5-5'])).toBe('v-macrev, assisted by claude-opus-5-5');
    expect(draftedByText(null, ['gpt-6.1-terra'])).toBe('gpt-6.1-terra');
    expect(listModels(['a-1', 'b-2', 'a-1', 'c-3'])).toBe('a-1, b-2 and c-3');
    expect(personOf('operator')).toBeNull();
    expect(personOf('  v-macrev ')).toBe('v-macrev');
  });

  it('co-author trailers in the repo\'s own form, only where the maker publishes an address', () => {
    expect(coAuthorTrailers(['claude-opus-5-5', 'gpt-6.2-sol', 'claude-sonnet-5-5', 'claude-opus-5-5'])).toEqual([
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>',
    ]);
  });
});

describe('the "Drafted by" header line', () => {
  it('replaces the skeleton\'s two-line placeholder with the finishing model', () => {
    const r = setDraftedBy(SKELETON, 'v-macrev', 'claude-opus-5-5');
    expect(r.content).toContain('// Drafted by v-macrev, assisted by claude-opus-5-5.\n// 0x27edf0');
    expect(r.content).not.toContain('skeleton.py');
    expect(setDraftedBy(r.content, 'v-macrev', 'claude-opus-5-5').change).toBeNull(); // idempotent
  });

  it('accumulates models when later packets of the unit pass on other models', () => {
    const one = setDraftedBy(SKELETON, 'v-macrev', 'gpt-6.2-sol').content;
    const two = setDraftedBy(one, 'v-macrev', 'claude-opus-5-5').content;
    expect(two).toContain('// Drafted by v-macrev, assisted by gpt-6.2-sol and claude-opus-5-5.');
    expect(two.match(/Drafted by/g)).toHaveLength(1);
  });

  it('keeps another contributor\'s line and adds ours after it', () => {
    const upstream = SKELETON.replace('// Drafted by decomp-orchestrator test, starting from\n// a tools/skeleton.py skeleton.', '// Drafted by Hinkiii, assisted by claude-sonnet-5-5.');
    const a = setDraftedBy(upstream, 'v-macrev', 'gpt-6.2-sol').content;
    expect(a).toContain('// Drafted by Hinkiii, assisted by claude-sonnet-5-5; later functions by v-macrev, assisted by gpt-6.2-sol.');
    const b = setDraftedBy(a, 'v-macrev', 'claude-opus-5-5').content;
    expect(b).toContain('; later functions by v-macrev, assisted by gpt-6.2-sol and claude-opus-5-5.');
    const models = SKELETON.replace('// Drafted by decomp-orchestrator test, starting from\n// a tools/skeleton.py skeleton.', '// Drafted by gpt-6.1-terra.');
    expect(setDraftedBy(models, null, 'gpt-6.2-sol').content).toContain('// Drafted by gpt-6.1-terra and gpt-6.2-sol.');
  });

  it('adds the line when the header has none', () => {
    const bare = SKELETON.replace('// Drafted by decomp-orchestrator test, starting from\n// a tools/skeleton.py skeleton.\n', '');
    expect(setDraftedBy(bare, null, 'gpt-6.2-sol').content).toContain('// Drafted by gpt-6.2-sol.\n#include');
  });

  it('header repair replaces a worker\'s own attribution with the attempt\'s model and passes the header rules', async () => {
    const worker = SKELETON.replace('// 0x27edf0', '// Drafted by me, an AI.\n// 0x27edf0');
    const r = await repairAnswer([{ path: 'r/TESObjectARMO.cpp', content: worker }], async () => SKELETON, {}, { attribution: { person: 'v-macrev', model: 'claude-opus-5-5' } });
    const out = r.files[0]!.content;
    expect(out).not.toContain('an AI');
    expect(out.match(/Drafted by/g)).toHaveLength(1);
    expect(out).toContain('// Drafted by v-macrev, assisted by claude-opus-5-5.');
    const target = [{ rva: '0x27edf0', name: 'TESObjectARMO::GetSkill', size: 31 }];
    expect(cheatScan({ path: 'r/TESObjectARMO.cpp', before: SKELETON, after: out, targets: target }).filter((f) => f.code.startsWith('CONV_'))).toEqual([]);
  });

  it('never touches a header file', async () => {
    const h = '// Source exposure: mixed.\n#pragma once\nclass A {};\n';
    const r = await repairAnswer([{ path: 'r/A.h', content: h }], async () => h, {}, { attribution: { person: null, model: 'gpt-6.2-sol' } });
    expect(r.files[0]!.content).toBe(h);
  });
});
