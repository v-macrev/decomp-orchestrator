// SPDX-License-Identifier: AGPL-3.0-or-later
// Task Context Bundles: a concise, deterministic package per packet. Same inputs → same bytes →
// same hash, so identical packets share a provider prompt-cache prefix and bundles are auditable.
//
// Sections, in fixed order: task spec · repo rules (docs) · lessons · unit files (as prepared) ·
// included headers · private pack (ONLY with the run's exposure consent; never persisted).
import { createHash } from 'node:crypto';
import type { BundleSection, ContextBundle } from '@decomp/core';
import type { Store, TaskRow } from '../db/store.js';
import type { DocSection, PreparedTask, RepoAdapter } from '../repo/types.js';

export interface BuildOptions {
  runId: string;
  exposureConsent: boolean;
  carried: Array<{ path: string; content: string }>;
}

export class ContextBuilder {
  private docsCache: DocSection[] | null = null;
  constructor(private repo: RepoAdapter, private store: Store) {}

  async build(task: TaskRow, prepared: PreparedTask, slot: number, opts: BuildOptions): Promise<ContextBundle> {
    const sections: BundleSection[] = [];
    const add = (id: string, title: string, source: string, content: string, privacy: 'public' | 'private' = 'public') => {
      if (content.trim()) sections.push({ id, title, source, content, privacy });
    };

    add('task', 'Packet', 'orchestrator', [
      `Unit: ${task.unit}`,
      `Allowed output paths (the only files you may return): ${prepared.allowedPaths.join(', ')}`,
      'Functions to reconstruct in this packet:',
      ...task.functions.map((f) => `- ${f.rva}  ${f.size} bytes  ${f.name ?? '(unnamed)'}${f.nameOrigin ? `  [name origin: ${f.nameOrigin}]` : ''}`),
    ].join('\n'));

    this.docsCache ??= await this.repo.docs();
    for (const d of this.docsCache) add(`doc:${d.id}`, d.title, d.source, d.content);

    const lessons = this.store.lessons(16);
    if (lessons.length) add('lessons', 'Lessons from past reviews', 'lessons', lessons.map((l) => `- ${l.text}`).join('\n'));

    for (const p of prepared.allowedPaths) {
      const text = await this.repo.readFile(slot, p);
      if (text !== null) add(`unit:${p}`, `Current ${p}`, p, text);
    }
    if (opts.carried.length) {
      add('carried', 'Accepted earlier in this run', 'orchestrator', `These unit files already contain functions that passed earlier in this run and are included above. Keep every one of them unchanged.\n${opts.carried.map((c) => `- ${c.path}`).join('\n')}`);
    }
    for (const h of await this.repo.includedHeaders(slot, prepared.allowedPaths)) add(h.id, h.title, h.source, h.content);

    if (opts.exposureConsent) {
      for (const pack of prepared.packs) {
        const text = await this.repo.readPack(pack);
        if (text) add(`pack:${pack}`, 'Private listing (read only; never reproduce bytes, mnemonics or pseudo-C names in output)', 'private-pack', text, 'private');
      }
    }

    const canon = JSON.stringify(sections.map((s) => [s.id, s.content]));
    const hash = createHash('sha256').update(canon).digest('hex');
    const bundle: ContextBundle = {
      hash,
      taskId: task.id,
      allowedPaths: prepared.allowedPaths,
      sections,
      approxTokens: Math.ceil(canon.length / 3.5),
      containsPrivate: sections.some((s) => s.privacy === 'private'),
    };
    // Persist for audit, with private sections redacted: game-derived text never leaves .local/.
    this.store.putBundle(hash, {
      ...bundle,
      sections: sections.map((s) => (s.privacy === 'private' ? { ...s, content: `[private: ${s.content.length} chars, sha256=${createHash('sha256').update(s.content).digest('hex').slice(0, 16)}]` } : s)),
    });
    return bundle;
  }
}
