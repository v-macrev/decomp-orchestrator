// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import type { Account, Effort, ModelSpec, ProviderKind, Usage } from '@decomp/core';

/** How a provider call ended, from the scheduler's point of view. Drives account health. */
export type OutcomeKind =
  | 'ok'
  | 'rate_limited' // 429 / usage limit: cool down this account, fail over
  | 'overloaded' // 529 / 503: provider-wide pressure
  | 'server_error' // 5xx
  | 'timeout'
  | 'network'
  | 'auth' // 401/403: disable account until an operator fixes it
  | 'quota' // billing / credits / plan quota: long cooldown
  | 'bad_request' // request's fault (400, context too long): no account penalty
  | 'refusal' // model declined: no account penalty
  | 'aborted'; // we cancelled: no account penalty

export interface RateLimitInfo {
  requestsRemaining?: number;
  inputTokensRemaining?: number;
  outputTokensRemaining?: number;
  /** ms until the provider's window resets (if reported) */
  resetMs?: number;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  model: ModelSpec;
  effort?: Effort;
  /** JSON Schema the response must satisfy (provider-native structured output where supported). */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  usage: Usage;
  stopReason: string | null;
  servedModel?: string;
  rateLimit?: RateLimitInfo;
}

export class ProviderError extends Error {
  constructor(
    readonly kind: OutcomeKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  complete(account: Account, req: CompletionRequest): Promise<CompletionResponse>;
}

export function resolveSecret(ref: string): string {
  if (ref.startsWith('env:')) {
    const v = process.env[ref.slice(4)];
    if (!v) throw new ProviderError('auth', `secret ${ref} is not set in the environment`);
    return v;
  }
  if (ref.startsWith('file:')) {
    try {
      return readFileSync(ref.slice(5), 'utf8').trim();
    } catch {
      throw new ProviderError('auth', `secret file for ${ref.slice(0, 12)}… is unreadable`);
    }
  }
  throw new ProviderError('auth', 'unsupported secretRef');
}

/** Parse Retry-After (seconds or HTTP date) into ms. */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

export function costUsd(model: ModelSpec, u: Usage): number {
  const uncachedIn = Math.max(0, u.inputTokens - u.cacheReadTokens);
  return (
    (uncachedIn * model.priceInPerMTok + u.cacheReadTokens * model.priceCacheReadPerMTok + u.outputTokens * model.priceOutPerMTok) / 1_000_000
  );
}
