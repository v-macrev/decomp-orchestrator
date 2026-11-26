// SPDX-License-Identifier: AGPL-3.0-or-later
// ComplexityClassifier: turns the discovered backlog into difficulty-routed packets.
//
//   features  repo.analyze (local packs → counts) ▸ else size-only estimate; + prior failures
//   score     core/complexity.ts (pure, reproducible, with reasons)
//   tie-break optional: borderline functions go to the Orchestrator's model in batches, features
//             only (numbers — never bytes, listings or decompiler output), capped per run
//   packets   per unit, grouped by difficulty: easy packs up to packetMaxFunctions, medium half
//             that, hard functions alone — so one hard sibling never drags easy ones to frontier
import {
  assessPacket, classify, harder, scoreFeatures, sizeOnlyFeatures,
  type ComplexityAssessment, type Difficulty, type FlowPlan, type FunctionFeatures, type FunctionTarget, type RoutingConfig,
} from '@decomp/core';
import type { Store } from '../db/store.js';
import type { AccountPool } from '../pool/scheduler.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { DiscoveredFunction, RepoAdapter } from '../repo/types.js';
import type { EventBus } from '../telemetry/events.js';
import { extractJson } from '../gatekeeper/review.js';
import { nameConfidence } from './x64features.js';

export interface RoutedPacket {
  unit: string;
  functions: FunctionTarget[];
  priority: number;
  difficulty: Difficulty;
  complexity: number;
  assessment: ComplexityAssessment;
}

interface Assessed {
  fn: DiscoveredFunction;
  features: FunctionFeatures;
  score: number;
  difficulty: Difficulty;
  borderline: boolean;
  llm: boolean;
}

const TIEBREAK_SYSTEM = `You estimate how hard it is to hand-write C++ that an MSVC x64 compiler turns into exactly the same machine code as an original function, given only summary counts of that function.
easy: straight-line or one branch, few calls, no floating point, no exception handling.
medium: a few branches or a loop, several calls or one virtual call, light float use.
hard: many branches, switch tables, loops plus virtual calls, heavy SSE/float math, or exception-handling funclets.
Reply with ONLY a JSON object: {"items":[{"id":"<id>","difficulty":"easy|medium|hard"}]} covering every id.`;

export class ComplexityClassifier {
  private tieBreaksUsed = new Map<string, number>();

  constructor(
    private deps: { store: Store; repo: RepoAdapter; pool?: AccountPool; providers?: ProviderRegistry; events?: EventBus },
  ) {}

  /** Features for every discovered function: local pack counts when available, else size-only. */
  async features(runId: string, found: DiscoveredFunction[]): Promise<Map<string, FunctionFeatures>> {
    const fromRepo = (await this.deps.repo.analyze?.(found).catch(() => null)) ?? new Map<string, FunctionFeatures>();
    const prior = this.deps.store.priorFailures(runId, found.map((f) => f.rva));
    const out = new Map<string, FunctionFeatures>();
    for (const f of found) {
      const base = fromRepo.get(f.rva) ?? f.features ?? sizeOnlyFeatures(f.size);
      out.set(f.rva, {
        ...base,
        priorFailures: prior.get(f.rva) ?? base.priorFailures ?? 0,
        nameConfidence: base.source === 'synthetic' ? base.nameConfidence : nameConfidence(f.name, f.nameOrigin),
        cautions: f.cautions ?? base.cautions ?? 0,
      });
    }
    return out;
  }

  /** Assess + partition the backlog into routed packets. */
  async plan(runId: string, found: DiscoveredFunction[], cfg: { routing: RoutingConfig; packetMaxFunctions: number }, plan: FlowPlan): Promise<RoutedPacket[]> {
    const t = cfg.routing.thresholds;
    const feats = await this.features(runId, found);
    const assessed: Assessed[] = found.map((fn) => {
      const features = feats.get(fn.rva)!;
      const s = scoreFeatures(features);
      const c = classify(s.score, t);
      return { fn, features, score: s.score, difficulty: c.difficulty, borderline: c.borderline, llm: false };
    });
    // A run of deterministic tiers only makes no model call, not even to break a tie.
    const modelFree = plan.tiers.every((t) => t.node.data.kind === 'deterministic');
    if (cfg.routing.enabled && cfg.routing.llmTieBreak && !modelFree) await this.tieBreak(runId, assessed, cfg.routing, plan);
    return partitionRouted(assessed, cfg.packetMaxFunctions, t, cfg.routing.enabled);
  }

  /**
   * Re-assess a packet after `prepare` created its local packs. Returns the new assessment when the
   * features got better (size-only → pack); the caller decides whether to move the task.
   */
  async refine(task: { functions: FunctionTarget[]; assessment: ComplexityAssessment | null }, packs: string[], routing: RoutingConfig): Promise<ComplexityAssessment | null> {
    if (task.assessment && task.assessment.features.source !== 'size_only') return null;
    if (!this.deps.repo.analyze) return null;
    const got = await this.deps.repo.analyze(task.functions, { packs }).catch(() => null);
    if (!got || !task.functions.every((f) => got.has(f.rva))) return null;
    const prior = task.assessment?.features;
    const feats = task.functions.map((f) => ({ ...got.get(f.rva)!, priorFailures: prior?.priorFailures ?? 0, nameConfidence: prior?.nameConfidence ?? nameConfidence(f.name, f.nameOrigin), cautions: prior?.cautions ?? 0 }));
    return { ...assessPacket(feats, routing.thresholds), functions: Object.fromEntries(task.functions.map((f, i) => [f.rva, feats[i]!])) };
  }

  private async tieBreak(runId: string, items: Assessed[], routing: RoutingConfig, plan: FlowPlan) {
    const { pool, providers, events } = this.deps;
    if (!pool || !providers) return;
    const used = this.tieBreaksUsed.get(runId) ?? 0;
    const border = items.filter((a) => a.borderline).slice(0, Math.max(0, routing.llmTieBreakMax - used));
    if (!border.length) return;
    let decided = 0;
    for (let i = 0; i < border.length; i += 25) {
      const batch = border.slice(i, i + 25);
      const payload = batch.map((a, k) => ({ id: `f${i + k}`, ...countsOnly(a.features), staticScore: a.score }));
      try {
        const lease = await pool.acquire({ binding: plan.orchestrator.data.pool, role: 'orchestrator', estInputTokens: 600 + 60 * batch.length, estOutputTokens: 30 * batch.length });
        try {
          const resp = await providers.complete(lease.account, {
            system: TIEBREAK_SYSTEM, prompt: `<complexity_batch>\n${JSON.stringify(payload)}\n</complexity_batch>`, model: lease.model,
            maxOutputTokens: 40 * batch.length + 200, timeoutMs: 120_000, signal: AbortSignal.timeout(130_000),
          });
          pool.release(lease, { kind: 'ok', usage: resp.usage });
          const parsed = extractJson(resp.text) as { items?: Array<{ id: string; difficulty: string }> } | null;
          for (const it of parsed?.items ?? []) {
            const k = Number(it.id.slice(1)) - i;
            const a = batch[k];
            if (!a || !['easy', 'medium', 'hard'].includes(it.difficulty)) continue;
            // The tie-breaker may only move a borderline function one step across the nearby threshold.
            const d = it.difficulty as Difficulty;
            if (Math.abs(rank(d) - rank(a.difficulty)) <= 1) {
              a.difficulty = d;
              a.llm = true;
              decided++;
            }
          }
        } catch (e) {
          pool.release(lease, { kind: (e as { kind?: never }).kind ?? 'network' });
          throw e;
        }
      } catch (e) {
        events?.emit('routing.tiebreak_failed', `LLM tie-break unavailable: ${(e as Error).message}; static scores kept`, { runId, level: 'warn' });
        break;
      }
    }
    this.tieBreaksUsed.set(runId, used + border.length);
    events?.emit('routing.tiebreak', `LLM tie-break settled ${decided}/${border.length} borderline function(s)`, { runId, data: { decided, borderline: border.length } });
  }
}

const rank = (d: Difficulty) => (d === 'easy' ? 0 : d === 'medium' ? 1 : 2);

function countsOnly(f: FunctionFeatures) {
  const { source: _s, nameConfidence: _n, ...rest } = f;
  return rest;
}

/** Per unit: group by difficulty, chunk by a per-difficulty packet cap, keep smaller/readier first. */
export function partitionRouted(items: Assessed[], packetMax: number, t: RoutingConfig['thresholds'], routingEnabled: boolean): RoutedPacket[] {
  const cap: Record<Difficulty, number> = { easy: packetMax, medium: Math.max(1, Math.ceil(packetMax / 2)), hard: 1 };
  const byUnit = new Map<string, Assessed[]>();
  for (const a of items) {
    const list = byUnit.get(a.fn.unit) ?? [];
    list.push(a);
    byUnit.set(a.fn.unit, list);
  }
  const out: RoutedPacket[] = [];
  for (const [unit, list] of byUnit) {
    const groups = new Map<Difficulty, Assessed[]>();
    for (const a of list) {
      const d = routingEnabled ? a.difficulty : 'medium';
      groups.set(d, [...(groups.get(d) ?? []), a]);
    }
    for (const [d, group] of groups) {
      group.sort((x, y) => x.fn.size - y.fn.size || x.fn.rva.localeCompare(y.fn.rva));
      const size = routingEnabled ? cap[d] : packetMax;
      for (let i = 0; i < group.length; i += size) {
        const chunk = group.slice(i, i + size);
        const assessment = assessPacket(chunk.map((c) => c.features), t);
        // A packet keeps at least the difficulty its functions were classified at (LLM decisions included).
        const difficulty = routingEnabled ? harder(chunk.reduce<Difficulty>((m, c) => harder(m, c.difficulty), 'easy'), assessment.difficulty) : 'medium';
        const decidedBy = chunk.some((c) => c.llm) ? 'llm' : 'static';
        const bytes = chunk.reduce((s, c) => s + c.fn.size, 0);
        const readiness = Math.min(...chunk.map((c) => c.fn.readiness ?? 3));
        out.push({
          unit,
          functions: chunk.map((c) => ({ rva: c.fn.rva, name: c.fn.name, size: c.fn.size, nameOrigin: c.fn.nameOrigin ?? null })),
          // Smaller, more "ready" packets first: they pass sooner and unlock carried context for later packets.
          priority: 1_000_000 - readiness * 10_000 - bytes - i,
          difficulty,
          complexity: assessment.score,
          assessment: { ...assessment, difficulty, decidedBy, functions: Object.fromEntries(chunk.map((c) => [c.fn.rva, c.features])) },
        });
      }
    }
  }
  return out;
}
