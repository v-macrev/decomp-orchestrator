// SPDX-License-Identifier: AGPL-3.0-or-later
// Append-only event log (per-function audit trail) + in-process fan-out for SSE subscribers.
import { EventEmitter } from 'node:events';
import type { TelemetryEvent } from '@decomp/core';
import type { Store } from '../db/store.js';

export type Level = TelemetryEvent['level'];

export class EventBus {
  private emitter = new EventEmitter();
  private insert;
  constructor(private store: Store | null, private echo: (e: TelemetryEvent) => void = () => {}) {
    this.emitter.setMaxListeners(1000);
    this.insert = store?.db.prepare('INSERT INTO events (ts, run_id, task_id, kind, level, msg, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }

  emit(kind: string, msg: string, opts: { runId?: string | null; taskId?: string | null; level?: Level; data?: Record<string, unknown> } = {}) {
    const ts = Date.now();
    const level = opts.level ?? 'info';
    let seq = 0;
    if (this.insert) {
      seq = Number(this.insert.run(ts, opts.runId ?? null, opts.taskId ?? null, kind, level, msg, opts.data ? JSON.stringify(opts.data) : null).lastInsertRowid);
    }
    const ev: TelemetryEvent = { seq, ts, runId: opts.runId ?? null, taskId: opts.taskId ?? null, kind, level, msg, data: opts.data ?? null };
    this.echo(ev);
    this.emitter.emit('event', ev);
    return ev;
  }

  subscribe(fn: (e: TelemetryEvent) => void) {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  query(opts: { runId?: string; taskId?: string; afterSeq?: number; limit?: number; minLevel?: Level }) {
    if (!this.store) return [];
    const levels: Level[] = ['debug', 'info', 'warn', 'error'];
    const allowed = levels.slice(levels.indexOf(opts.minLevel ?? 'debug'));
    const where: string[] = ['seq > @after', `level IN (${allowed.map((l) => `'${l}'`).join(',')})`];
    if (opts.runId) where.push('run_id = @runId');
    if (opts.taskId) where.push('task_id = @taskId');
    const rows = this.store.db
      .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT @limit`)
      .all({ after: opts.afterSeq ?? 0, runId: opts.runId, taskId: opts.taskId, limit: opts.limit ?? 200 }) as any[];
    return rows.reverse().map(
      (r): TelemetryEvent => ({ seq: r.seq, ts: r.ts, runId: r.run_id, taskId: r.task_id, kind: r.kind, level: r.level, msg: r.msg, data: r.data_json ? JSON.parse(r.data_json) : null }),
    );
  }
}
