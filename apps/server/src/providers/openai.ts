// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenAI and any OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, OpenRouter, Azure-compatible
// gateways). Chat Completions is used because it is the lowest common denominator across servers.
import OpenAI from 'openai';
import type { Account } from '@decomp/core';
import {
  ProviderError, parseRetryAfter, resolveSecret,
  type CompletionRequest, type CompletionResponse, type ProviderAdapter, type RateLimitInfo,
} from './types.js';

function header(h: unknown, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  return (h as Record<string, string>)[name];
}

const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);

export class OpenAIAdapter implements ProviderAdapter {
  private clients = new Map<string, OpenAI>();
  constructor(readonly kind: 'openai' | 'openai_compat') {}

  private client(account: Account): OpenAI {
    const cached = this.clients.get(account.id);
    if (cached) return cached;
    const a = account.auth;
    const apiKey = a.type === 'api_key' || a.type === 'oauth_token' ? resolveSecret(a.secretRef) : 'not-needed';
    if (this.kind === 'openai_compat' && !account.baseUrl) throw new ProviderError('auth', 'openai_compat accounts require baseUrl');
    const c = new OpenAI({ apiKey, baseURL: account.baseUrl, maxRetries: 0 });
    this.clients.set(account.id, c);
    return c;
  }

  invalidate(accountId: string) {
    this.clients.delete(accountId);
  }

  async complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.client(account);
    // json mode: 'schema' (strict-ish json_schema), 'object' (json_object), 'none' (prompt only)
    const jsonMode = (account.options.jsonMode as string | undefined) ?? (this.kind === 'openai' ? 'schema' : 'object');
    const response_format =
      req.jsonSchema && jsonMode === 'schema'
        ? { type: 'json_schema' as const, json_schema: { name: 'worker_output', schema: req.jsonSchema, strict: false } }
        : req.jsonSchema && jsonMode === 'object'
          ? { type: 'json_object' as const }
          : undefined;
    const effort = req.effort ?? req.model.defaultEffort;
    const reasoning_effort =
      effort && account.options.reasoningEffort !== false && this.kind === 'openai'
        ? ((effort === 'xhigh' || effort === 'max' ? 'high' : effort) as 'low' | 'medium' | 'high')
        : undefined;
    try {
      const { data, response } = await client.chat.completions
        .create(
          {
            model: req.model.id,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
            max_completion_tokens: req.maxOutputTokens,
            ...(response_format ? { response_format } : {}),
            ...(reasoning_effort ? { reasoning_effort } : {}),
            // OpenAI caches prompt prefixes automatically (≥1024 tokens). The system prompt is the
            // byte-identical static prefix; the key keeps same-prefix requests on the same cache shard.
            ...(req.cacheKey && this.kind === 'openai' && account.options.promptCacheKey !== false ? { prompt_cache_key: req.cacheKey } : {}),
          },
          { signal: req.signal, timeout: req.timeoutMs },
        )
        .withResponse();
      const choice = data.choices[0];
      const text = choice?.message?.content ?? '';
      if ((choice?.message as { refusal?: string | null } | undefined)?.refusal) throw new ProviderError('refusal', 'model refused');
      const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const rateLimit: RateLimitInfo = {
        requestsRemaining: num(header(response.headers, 'x-ratelimit-remaining-requests')),
        inputTokensRemaining: num(header(response.headers, 'x-ratelimit-remaining-tokens')),
      };
      return {
        text,
        stopReason: choice?.finish_reason ?? null,
        servedModel: data.model,
        rateLimit,
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 },
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

export function mapOpenAIError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('aborted', 'aborted');
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError('timeout', 'request timed out');
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('network', err.message);
  if (err instanceof OpenAI.APIError) {
    const retry = parseRetryAfter(header(err.headers, 'retry-after'));
    const code = (err.code ?? '') as string;
    const msg = `${err.status ?? ''} ${code || err.type || ''}`.trim();
    if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return new ProviderError('quota', msg, retry, err.status);
    if (err instanceof OpenAI.RateLimitError) return new ProviderError('rate_limited', msg, retry, 429);
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return new ProviderError('auth', msg, undefined, err.status);
    if (err.status === 503 || err.status === 529) return new ProviderError('overloaded', msg, retry, err.status);
    if (err instanceof OpenAI.InternalServerError) return new ProviderError('server_error', msg, retry, err.status);
    if (err.status === 408) return new ProviderError('timeout', msg, retry, err.status);
    return new ProviderError('bad_request', msg, undefined, err.status);
  }
  return new ProviderError('network', err instanceof Error ? err.message : String(err));
}
