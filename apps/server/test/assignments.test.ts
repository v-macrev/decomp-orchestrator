// SPDX-License-Identifier: AGPL-3.0-or-later
// The Accounts tab's assignment grid: which account·model serves each flow node.
import { describe, expect, it } from 'vitest';
import { Account, defaultFlow, type CapabilityTier, type Role } from '@decomp/core';
import { flowAssignments } from '../src/pool/assignments.js';

const model = (id: string, capability: CapabilityTier | undefined, roles: Role[] = ['worker']) => ({ id, capability, roles });
const claude = (id: string, enabled = true) => Account.parse({
  id, label: id, provider: 'claude_cli', auth: { type: 'cli_profile', configDir: `/x/${id}` }, tags: ['cheap', 'strong', 'orchestrator'], enabled,
  models: [model('claude-haiku-5-5', 'fast', ['worker', 'orchestrator']), model('claude-sonnet-5-5', 'balanced'), model('claude-opus-5-5', 'frontier', ['worker', 'gatekeeper', 'orchestrator'])],
});
const codex = Account.parse({
  id: 'codex', label: 'codex', provider: 'codex_cli', auth: { type: 'cli_profile', configDir: '/x/codex' }, tags: ['cheap', 'strong'],
  models: [model('gpt-6-luna', 'fast'), model('gpt-5.6-terra', 'balanced')],
});
const pairs = (n: { serves: Array<{ accountId: string; modelId: string }> }) => n.serves.map((s) => `${s.accountId}/${s.modelId}`).sort();

describe('flow assignments', () => {
  it('maps each node of the default flow to the models the scheduler would pick', () => {
    const r = flowAssignments(defaultFlow(), [claude('ws1'), claude('ws2'), codex]);
    const node = (id: string) => r.nodes.find((n) => n.nodeId === id)!;
    expect(pairs(node('worker-fast'))).toEqual(['codex/gpt-6-luna', 'ws1/claude-haiku-5-5', 'ws2/claude-haiku-5-5']);
    expect(pairs(node('worker-balanced'))).toEqual(['codex/gpt-5.6-terra', 'ws1/claude-sonnet-5-5', 'ws2/claude-sonnet-5-5']);
    expect(pairs(node('worker-frontier'))).toEqual(['ws1/claude-opus-5-5', 'ws2/claude-opus-5-5']);
    expect(node('worker-frontier').fallback).toBe(false);
    // The orchestrator node only takes accounts tagged #orchestrator, and uses each account's first orchestrator model.
    expect(pairs(node('orchestrator'))).toEqual(['ws1/claude-haiku-5-5', 'ws2/claude-haiku-5-5']);
    expect(node('orchestrator').excluded).toEqual([{ accountId: 'codex', reason: 'node only takes accounts tagged #orchestrator' }]);
    // Without LLM review the Gate Keeper runs deterministic checks only.
    expect(node('gate').usesModel).toBe(false);
  });

  it('flags a tier no model declares (any worker model then serves it) and skips disabled accounts', () => {
    const r = flowAssignments(defaultFlow(), [claude('ws1', false), codex]);
    const frontier = r.nodes.find((n) => n.nodeId === 'worker-frontier')!;
    expect(frontier.fallback).toBe(true);
    expect(pairs(frontier)).toEqual(['codex/gpt-6-luna']);
  });
});
