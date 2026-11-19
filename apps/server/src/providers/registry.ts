// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, ProviderKind } from '@decomp/core';
import { AnthropicAdapter } from './anthropic.js';
import { ClaudeCliAdapter, CodexCliAdapter } from './cli.js';
import { MockAdapter, type SimOracle } from './mock.js';
import { OpenAIAdapter } from './openai.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from './types.js';

export class ProviderRegistry {
  private adapters = new Map<ProviderKind, ProviderAdapter>();

  constructor(opts: { oracle?: SimOracle } = {}) {
    this.register(new AnthropicAdapter());
    this.register(new OpenAIAdapter('openai'));
    this.register(new OpenAIAdapter('openai_compat'));
    this.register(new ClaudeCliAdapter());
    this.register(new CodexCliAdapter());
    this.register(new MockAdapter(opts.oracle));
  }

  register(a: ProviderAdapter) {
    this.adapters.set(a.kind, a);
  }

  /** Drop cached SDK clients after an account's credentials change. */
  invalidate(accountId: string) {
    for (const a of this.adapters.values()) (a as { invalidate?: (id: string) => void }).invalidate?.(accountId);
  }

  complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    const a = this.adapters.get(account.provider);
    if (!a) return Promise.reject(new ProviderError('bad_request', `no adapter for provider ${account.provider}`));
    return a.complete(account, req);
  }
}
