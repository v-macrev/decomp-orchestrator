// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AccountPool, type Lease } from '../src/pool/scheduler.js';
import { MockAdapter } from '../src/providers/mock.js';
import { ProviderError } from '../src/providers/types.js';
import { FakeClock, mockAccount, req } from './helpers.js';

const ok = { kind: 'ok' as const, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, latencyMs: 100 };

function lease(pool: AccountPool, over: Record<string, unknown> = {}): Lease {
  const r = pool.tryAcquire(req(over));
  if (!('lease' in r)) throw new Error(`expected lease, got wait ${r.waitMs} ${r.reason}`);
  return r.lease;
}

describe('AccountPool failover', () => {
  it('fails over from a rate-limited account and honours retry-after', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a', { priority: 10 }), mockAccount('b')], null, null, {}, clock.now);
    const l1 = lease(pool);
    expect(l1.account.id).toBe('a'); // priority wins
    pool.release(l1, { kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(pool.view().find((v) => v.accountId === 'a')!.status).toBe('cooling');

    const l2 = lease(pool);
    expect(l2.account.id).toBe('b'); // a is cooling → immediate failover, no stall
    pool.release(l2, ok);

    clock.advance(30_001);
    expect(lease(pool).account.id).toBe('a'); // back after the cooldown
  });

  it('backs off exponentially when 429s carry no retry-after', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a')], null, null, { rateLimitBaseMs: 1_000 }, clock.now);
    const cooldowns: number[] = [];
    for (let i = 0; i < 4; i++) {
      const l = lease(pool);
      pool.release(l, { kind: 'rate_limited' });
      const v = pool.view()[0]!;
      cooldowns.push(v.cooldownUntil! - clock.t);
      clock.advance(v.cooldownUntil! - clock.t + 1);
      // refill rpm bucket that release() drained
      clock.advance(1_000);
    }
    for (let i = 1; i < cooldowns.length; i++) expect(cooldowns[i]!).toBeGreaterThan(cooldowns[i - 1]! * 1.4);
  });

  it('returns the earliest wait when every account is unavailable', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a'), mockAccount('b')], null, null, {}, clock.now);
    pool.release(lease(pool, { avoid: ['b'] }), { kind: 'rate_limited', retryAfterMs: 10_000 });
    pool.release(lease(pool, { avoid: ['a'] }), { kind: 'rate_limited', retryAfterMs: 4_000 });
    const r = pool.tryAcquire(req());
    expect('waitMs' in r && r.waitMs).toBeGreaterThan(3_000);
    expect('waitMs' in r && r.waitMs).toBeLessThanOrEqual(4_000);
  });
});

describe('adaptive concurrency (AIMD)', () => {
  it('halves the limit on 429 and grows it back on success, never above the cap', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a', { limits: { requestsPerMinute: 10_000, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 8 } })], null, null, {}, clock.now);
    pool.release(lease(pool), { kind: 'rate_limited', retryAfterMs: 1 });
    expect(pool.view()[0]!.concurrencyLimit).toBe(4);
    clock.advance(10_000);
    for (let i = 0; i < 200; i++) pool.release(lease(pool), ok);
    expect(pool.view()[0]!.concurrencyLimit).toBe(8);
  });

  it('enforces the effective concurrency limit', () => {
    const pool = new AccountPool([mockAccount('a')], null, null);
    const held = [lease(pool), lease(pool), lease(pool), lease(pool)];
    expect('waitMs' in pool.tryAcquire(req())).toBe(true);
    pool.release(held[0]!, ok);
    expect('lease' in pool.tryAcquire(req())).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('opens after consecutive failures, probes once, and closes on success', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a')], null, null, { failureThreshold: 3, circuitBaseMs: 10_000 }, clock.now);
    for (let i = 0; i < 3; i++) pool.release(lease(pool), { kind: 'server_error' });
    expect(pool.view()[0]!.status).toBe('circuit_open');
    expect('waitMs' in pool.tryAcquire(req())).toBe(true);

    clock.advance(12_000);
    const probe = lease(pool);
    expect(probe.probe).toBe(true);
    expect('waitMs' in pool.tryAcquire(req())).toBe(true); // only one probe at a time
    pool.release(probe, ok);
    expect(pool.view()[0]!.status).toBe('ok');
  });

  it('re-opens with a doubled timeout when the probe fails', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a')], null, null, { failureThreshold: 1, circuitBaseMs: 10_000 }, clock.now);
    pool.release(lease(pool), { kind: 'timeout' });
    const first = pool.view()[0]!.cooldownUntil! - clock.t;
    clock.advance(first + 1);
    pool.release(lease(pool), { kind: 'timeout' });
    const second = pool.view()[0]!.cooldownUntil! - clock.t;
    expect(second).toBeGreaterThan(first * 1.6);
  });
});

describe('health classification', () => {
  it('disables on auth failure, never penalises request-caused errors', () => {
    const pool = new AccountPool([mockAccount('a'), mockAccount('b')], null, null, { failureThreshold: 2 });
    for (let i = 0; i < 10; i++) pool.release(lease(pool, { avoid: ['b'] }), { kind: 'bad_request' });
    for (let i = 0; i < 10; i++) pool.release(lease(pool, { avoid: ['b'] }), { kind: 'refusal' });
    expect(pool.view().find((v) => v.accountId === 'a')!.status).toBe('ok');
    pool.release(lease(pool, { avoid: ['b'] }), { kind: 'auth', message: '401' });
    expect(pool.view().find((v) => v.accountId === 'a')!.status).toBe('disabled');
    for (let i = 0; i < 5; i++) {
      const l = lease(pool);
      expect(l.account.id).toBe('b');
      pool.release(l, ok);
    }
  });

  it('marks quota exhausted when the daily budget is hit', () => {
    const pool = new AccountPool([mockAccount('a', { limits: { requestsPerMinute: 600, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 4, dailyBudgetUsd: 0.01 } })], null, null);
    pool.release(lease(pool), { kind: 'ok', usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(pool.view()[0]!.status).toBe('quota_exhausted');
  });
});

describe('token buckets', () => {
  it('waits on input-token budget and refunds over-reservation', () => {
    const clock = new FakeClock();
    const pool = new AccountPool([mockAccount('a', { limits: { requestsPerMinute: 1000, inputTokensPerMinute: 10_000, outputTokensPerMinute: 1e9, maxConcurrency: 16 } })], null, null, {}, clock.now);
    const l = lease(pool, { estInputTokens: 9_000 });
    const r = pool.tryAcquire(req({ estInputTokens: 9_000 }));
    expect('waitMs' in r && r.waitMs > 0).toBe(true);
    pool.release(l, { kind: 'ok', usage: { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }); // refund 8k
    expect('lease' in pool.tryAcquire(req({ estInputTokens: 8_000 }))).toBe(true);
  });
});

describe('routing', () => {
  it('bound bindings use only the bound accounts; tags filter pools', () => {
    const pool = new AccountPool([mockAccount('a', { tags: ['cheap'] }), mockAccount('b', { tags: ['strong'] }), mockAccount('c', { tags: ['strong'] })], null, null);
    for (let i = 0; i < 3; i++) {
      const l = lease(pool, { binding: { strategy: 'bound', accountIds: ['c'], tags: [] } });
      expect(l.account.id).toBe('c');
      pool.release(l, ok);
    }
    const seen = new Set<string>();
    const held: Lease[] = [];
    for (let i = 0; i < 6; i++) {
      const l = lease(pool, { binding: { strategy: 'pool', accountIds: [], tags: ['strong'] } });
      seen.add(l.account.id);
      held.push(l); // holding leases spreads load across both strong accounts
    }
    expect([...seen].sort()).toEqual(['b', 'c']);
  });
});

describe('stress: partial failures under load', () => {
  it('completes every request across flaky accounts without exceeding caps', async () => {
    const accounts = [
      mockAccount('claude-ws-a', { options: { latencyMs: [1, 4], rateLimitRate: 0.15, retryAfterMs: 50 } }),
      mockAccount('claude-ws-b', { options: { latencyMs: [1, 4], serverErrorRate: 0.25 } }),
      mockAccount('gpt-a', { options: { latencyMs: [1, 4], authFail: true } }),
      mockAccount('local', { options: { latencyMs: [1, 4] }, limits: { requestsPerMinute: 100_000, inputTokensPerMinute: 1e9, outputTokensPerMinute: 1e9, maxConcurrency: 2 } }),
    ];
    const pool = new AccountPool(accounts, null, null, { failureThreshold: 3, circuitBaseMs: 100, rateLimitBaseMs: 20, overloadCooldownMs: 20 });
    const adapter = new MockAdapter();
    let maxSeen = 0;
    const inflight = new Map<string, number>();
    let done = 0;
    const one = async () => {
      for (;;) {
        const l = await pool.acquire(req({ estInputTokens: 100, estOutputTokens: 100 }));
        const k = l.account.id;
        inflight.set(k, (inflight.get(k) ?? 0) + 1);
        maxSeen = Math.max(maxSeen, ...[...inflight.entries()].map(([id, n]) => n / accounts.find((a) => a.id === id)!.limits.maxConcurrency));
        try {
          const r = await adapter.complete(l.account, { system: 's', prompt: 'p', model: l.model, maxOutputTokens: 100, timeoutMs: 1000, signal: new AbortController().signal });
          pool.release(l, { kind: 'ok', usage: r.usage, latencyMs: 2 });
          done++;
          return;
        } catch (e) {
          const pe = e as ProviderError;
          pool.release(l, { kind: pe.kind, retryAfterMs: pe.retryAfterMs });
        } finally {
          inflight.set(k, inflight.get(k)! - 1);
        }
      }
    };
    await Promise.all(Array.from({ length: 300 }, one));
    expect(done).toBe(300);
    expect(maxSeen).toBeLessThanOrEqual(1);
    const v = pool.view();
    expect(v.find((x) => x.accountId === 'gpt-a')!.status).toBe('disabled');
    expect(v.find((x) => x.accountId === 'claude-ws-a')!.rateLimitedTotal).toBeGreaterThan(0);
    pool.close();
  }, 30_000);
});
