// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export class AbortedError extends Error {
  constructor(msg = 'aborted') {
    super(msg);
    this.name = 'AbortedError';
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Counting semaphore with FIFO fairness and abort support. */
export class Semaphore {
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  constructor(private permits: number) {}

  get available() {
    return this.permits;
  }
  get waiting() {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortedError();
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits--;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const w = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
    return this.releaser();
  }

  private releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.permits++;
    };
  }
}

/** A level-triggered wake-up signal: wait() resolves on the next notify() or timeout. */
export class Notifier {
  private pending: Array<() => void> = [];
  notify() {
    const p = this.pending;
    this.pending = [];
    for (const r of p) r();
  }
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const t = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
      this.pending.push(finish);
    });
  }
}

/** Simple async mutex keyed by string (e.g. serialize `sr claim/start` on the shared local dir). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export const jitter = (ms: number, frac = 0.2) => Math.round(ms * (1 - frac + Math.random() * 2 * frac));
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
