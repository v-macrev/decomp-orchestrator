// SPDX-License-Identifier: AGPL-3.0-or-later
// Claude via the official SDK. SDK retries are disabled (maxRetries: 0): retry and failover are
// the scheduler's job, so a throttled account immediately yields to another one.
import Anthropic from '@anthropic-ai/sdk';
import type { Account } from '@decomp/core';
import {
  ProviderError, parseRetryAfter, resolveSecret,
  type CompletionRequest, type CompletionResponse, type ProviderAdapter,
} from './types.js';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/;

function header(h: unknown, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  return (h as Record<string, string>)[name];
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;
  private clients = new Map<string, Anthropic>();

  private client(account: Account): Anthropic {
    const cached = this.clients.get(account.id);
    if (cached) return cached;
    const a = account.auth;
    let client: Anthropic;
    if (a.type === 'api_key') {
      client = new Anthropic({ apiKey: resolveSecret(a.secretRef), authToken: null, baseURL: account.baseUrl ?? null, maxRetries: 0 });
    } else if (a.type === 'oauth_token') {
      client = new Anthropic({
        apiKey: null, authToken: resolveSecret(a.secretRef), baseURL: account.baseUrl ?? null, maxRetries: 0,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      });
    } else {
      throw new ProviderError('auth', `anthropic accounts need api_key or oauth_token auth (got ${a.type}); use provider claude_cli for CLI profiles`);
    }
    this.clients.set(account.id, client);
    return client;
  }

  invalidate(accountId: string) {
    this.clients.delete(accountId);
  }

  async complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.client(account);
    const useFallback = account.options.refusalFallback !== false && FALLBACK_MODELS.test(req.model.id);
    const output_config: Record<string, unknown> = {};
    if (req.effort ?? req.model.defaultEffort) output_config.effort = req.effort ?? req.model.defaultEffort;
    if (req.jsonSchema && account.options.structuredOutput !== false) output_config.format = { type: 'json_schema', schema: req.jsonSchema };

    const params = {
      model: req.model.id,
      max_tokens: req.maxOutputTokens,
      // The system prompt is identical across every packet of a run → cached prefix.
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: req.prompt }],
      ...(Object.keys(output_config).length ? { output_config } : {}),
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };

    try {
      const stream = client.beta.messages.stream(params as Parameters<typeof client.beta.messages.stream>[0], { signal: req.signal, timeout: req.timeoutMs });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new ProviderError('refusal', 'model declined the request (stop_reason=refusal)');
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const u = msg.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      return {
        text,
        stopReason: msg.stop_reason,
        servedModel: msg.model,
        usage: { inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
      };
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}

export function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'aborted');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'request timed out');
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', err.message);
  if (err instanceof Anthropic.APIError) {
    const retry = parseRetryAfter(header(err.headers, 'retry-after'));
    const msg = `${err.status ?? ''} ${err.type ?? ''}`.trim();
    if (err.type === 'billing_error') return new ProviderError('quota', msg, retry, err.status);
    if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited', msg, retry, 429);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', msg, undefined, err.status);
    if (err.status === 529 || err.type === 'overloaded_error') return new ProviderError('overloaded', msg, retry, err.status);
    if (err instanceof Anthropic.InternalServerError) return new ProviderError('server_error', msg, retry, err.status);
    if (err.status === 408 || err.type === 'timeout_error') return new ProviderError('timeout', msg, retry, err.status);
    return new ProviderError('bad_request', msg, undefined, err.status);
  }
  return new ProviderError('network', err instanceof Error ? err.message : String(err));
}
