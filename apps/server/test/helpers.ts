// SPDX-License-Identifier: AGPL-3.0-or-later
import { Account } from '@decomp/core';

export function mockAccount(id: string, over: Partial<Account> & { options?: Record<string, unknown> } = {}): Account {
  return Account.parse({
    id,
    label: id,
    provider: 'mock',
    auth: { type: 'none' },
    models: [{ id: `${id}-model`, roles: ['worker', 'gatekeeper', 'orchestrator'], priceInPerMTok: 1, priceOutPerMTok: 5 }],
    limits: { requestsPerMinute: 600, inputTokensPerMinute: 1_000_000, outputTokensPerMinute: 1_000_000, maxConcurrency: 4 },
    ...over,
  });
}

export class FakeClock {
  t = 1_700_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export const POOL = { strategy: 'pool' as const, accountIds: [], tags: [] };
export const req = (over: Record<string, unknown> = {}) => ({ binding: POOL, role: 'worker' as const, estInputTokens: 1000, estOutputTokens: 1000, ...over });
