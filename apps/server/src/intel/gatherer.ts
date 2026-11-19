// SPDX-License-Identifier: AGPL-3.0-or-later
// FunctionGatherer: the Orchestrator's view of "what still needs decompiling", built from the
// repository itself rather than a fixed list.
//
//   inventory      data/progress.json (public): every function, its status, name, name origin, size
//   candidates     `sr next` over the whole backlog: the repo's own unit mapping, readiness order and
//                  claim exclusion (others' claims when GitHub is reachable)
//   locks          local claims (SR_LOCAL_DIR/contrib/claims.json) + this tool's own open/unsubmitted work
//   source scan    the unit's header/source at the base revision: declared signature, and whether a
//                  draft of the function is already there (non-trivial, stub, or none)
//   shape          local packs (counts only: instructions, blocks, branches, calls, SSE, EH) and, when
//                  the operator opts in, a locally exported function table (incoming/outgoing xrefs)
//
// Filters (size, RVA ranges, namespaces, modules, units, name origin, locks, in-flight, drafted) are
// applied before the cap, in readiness / size / RVA order. Every exclusion is counted in the report
// so a short batch explains itself. Nothing game-derived leaves the machine: listings are never read
// here, and the report carries names, sizes and counts only.
import { GatherFilter, sizeOnlyFeatures, type FunctionFeatures } from '@decomp/core';
import type { Store } from '../db/store.js';
import { extractFunctions, lex } from '../gatekeeper/cpp.js';
import { TRIVIAL_BODIES } from '../gatekeeper/rules.js';
import { findSignature } from '../orchestrator/contextBuilder.js';
import type { DiscoveredFunction, RepoAdapter } from '../repo/types.js';

export type DraftState = 'none' | 'stub' | 'present';

export interface GatheredFunction extends DiscoveredFunction {
  header: string | null;
  unitExists: boolean;
  signature: string | null;
  draft: DraftState;
  xrefsIn: number | null;
  xrefsOut: number | null;
  basicBlocks: number | null;
  instructions: number | null;
  branches: number | null;
  /** Where the metadata came from: inventory, sr-next, source, pack, table. */
  sources: string[];
}

export type ExclusionReason =
  | 'matched' | 'not_startable' | 'locked' | 'in_flight' | 'size' | 'rva_range' | 'namespace' | 'module' | 'unit' | 'name_origin' | 'drafted' | 'over_cap';

export interface GatherReport {
  source: string;
  at: number;
  filter: GatherFilter;
  inventory: { total: number; matched: number; mapped: number; other: number };
  candidates: number;
  claimsChecked: boolean;
  excluded: Partial<Record<ExclusionReason, number>>;
  selected: number;
  selectedBytes: number;
  withPackFeatures: number;
  withTableFacts: number;
  units: number;
  byModule: Record<string, number>;
  functions: GatheredFunction[];
}

const flat = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : null);
const pick = (row: Record<string, unknown> | undefined, keys: string[]): number | null => {
  if (!row) return null;
  for (const k of keys) {
    const v = num(row[k]);
    if (v !== null) return v;
  }
  return null;
};

/** `reconstruction/<area>/<Class>.cpp` → area (the "module" a filter selects). */
export function moduleOf(unit: string): string {
  const parts = unit.split('/');
  return parts[0] === 'reconstruction' && parts.length > 2 ? parts[1]! : parts.slice(0, -1).join('/') || '.';
}

/** Qualified-name prefix on `::` boundaries ("RE" matches RE::X::Y, not REFR::Y). */
export function inNamespace(name: string | null, prefixes: string[]): boolean {
  if (!prefixes.length) return true;
  if (!name) return false;
  return prefixes.some((p) => name === p || name.startsWith(`${p}::`));
}

export class FunctionGatherer {
  constructor(private repo: RepoAdapter, private store: Store) {}

  async gather(filterIn: unknown, opts: { runId?: string } = {}): Promise<GatherReport> {
    const filter = GatherFilter.parse(filterIn ?? {});
    if (!this.repo.backlog) throw new Error(`the ${this.repo.name} repository adapter cannot gather functions`);
    const b = await this.repo.backlog({ maxSize: filter.maxSize });
    const excluded: Partial<Record<ExclusionReason, number>> = {};
    const drop = (r: ExclusionReason, n = 1) => (excluded[r] = (excluded[r] ?? 0) + n);

    const inv = { total: b.inventory.length, matched: 0, mapped: 0, other: 0 };
    for (const e of b.inventory) inv[e.status === 'matched' ? 'matched' : e.status === 'mapped' ? 'mapped' : 'other']++;
    drop('matched', inv.matched);

    const claimed = new Set(b.claimed);
    const candidateRvas = new Set(b.candidates.map((c) => c.rva));
    // Mapped functions the repo could not offer: claimed (locked) or not startable (no unit mapping, too big, ...).
    for (const e of b.inventory) {
      if (e.status !== 'mapped' || candidateRvas.has(e.rva)) continue;
      if (claimed.has(e.rva)) drop('locked');
      else if (e.size > filter.maxSize) drop('size');
      else drop('not_startable');
    }
    const inFlight = filter.excludeInFlight ? this.store.rvasInFlight(opts.runId ?? null) : new Set<string>();
    const ranges = filter.rvaRanges.map((r) => [parseInt(r.start, 16), parseInt(r.end, 16)] as const);
    const units = new Set(filter.units);
    const origins = new Set(filter.excludeNameOrigins.map((o) => o.toUpperCase()));

    const pass: DiscoveredFunction[] = [];
    for (const c of b.candidates) {
      if (filter.excludeLocked && claimed.has(c.rva)) drop('locked');
      else if (inFlight.has(c.rva)) drop('in_flight');
      else if (c.size > filter.maxSize || (filter.minSize !== undefined && c.size < filter.minSize)) drop('size');
      else if (ranges.length && !ranges.some(([s, e]) => parseInt(c.rva, 16) >= s && parseInt(c.rva, 16) < e)) drop('rva_range');
      else if (!inNamespace(c.name, filter.namespaces)) drop('namespace');
      else if (filter.modules.length && !filter.modules.includes(moduleOf(c.unit))) drop('module');
      else if (units.size && !units.has(c.unit)) drop('unit');
      else if (c.nameOrigin && origins.has(c.nameOrigin.toUpperCase())) drop('name_origin');
      else pass.push(c);
    }
    // Readiness keeps the repository's own order (lower rank first); ties by size, then RVA.
    const key = (f: DiscoveredFunction): number[] =>
      filter.order === 'size' ? [f.size, parseInt(f.rva, 16)] : filter.order === 'rva' ? [parseInt(f.rva, 16)] : [f.readiness ?? 9, f.size, parseInt(f.rva, 16)];
    pass.sort((a, b2) => {
      const ka = key(a);
      const kb = key(b2);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
      return 0;
    });

    // Source scan in order until the cap is filled (excluding drafted functions may skip some).
    const unitCache = new Map<string, { h: string | null; cpp: string | null; defs: Map<string, string> | null }>();
    const scan = async (unit: string) => {
      let u = unitCache.get(unit);
      if (!u) {
        const hPath = unit.replace(/\.cpp$/, '.h');
        const [h, cpp] = await Promise.all([this.repo.baseFile(hPath).catch(() => null), this.repo.baseFile(unit).catch(() => null)]);
        let defs: Map<string, string> | null = null;
        if (cpp) {
          defs = new Map();
          for (const d of extractFunctions(lex(cpp).code)) defs.set(flat(d.name), cpp.slice(d.open + 1, d.close).replace(/\s+/g, ' ').trim());
        }
        u = { h, cpp, defs };
        unitCache.set(unit, u);
      }
      return u;
    };
    const chosen: GatheredFunction[] = [];
    for (const c of pass) {
      if (chosen.length >= filter.maxFunctions) {
        drop('over_cap');
        continue;
      }
      const u = await scan(c.unit);
      const body = c.name ? u.defs?.get(flat(c.name)) ?? u.defs?.get(flat(c.name.split('::').pop()!)) : undefined;
      const draft: DraftState = body === undefined ? 'none' : TRIVIAL_BODIES.has(body.replace(/\s+/g, ' ').trim()) ? 'stub' : 'present';
      if (filter.excludeDrafted && draft === 'present') {
        drop('drafted');
        continue;
      }
      const signature = c.name ? findSignature(c.name, [u.h, u.cpp].filter((x): x is string => !!x)) : null;
      chosen.push({
        ...c, header: c.unit.replace(/\.cpp$/, '.h'), unitExists: u.cpp !== null, signature, draft,
        xrefsIn: null, xrefsOut: null, basicBlocks: null, instructions: null, branches: null,
        sources: ['inventory', b.source.includes('sr next') ? 'sr-next' : 'backlog', ...(u.h || u.cpp ? ['source'] : [])],
      });
    }

    // Shape: local packs first, then the optional function table for xrefs/blocks.
    const packs = (await this.repo.analyze?.(chosen).catch(() => null)) ?? new Map<string, FunctionFeatures>();
    let withPack = 0;
    let withTable = 0;
    for (const f of chosen) {
      const pack = packs.get(f.rva) ?? (f.features && f.features.source !== 'size_only' ? f.features : undefined);
      const row = b.functionTable?.get(f.rva);
      const feats: FunctionFeatures = { ...(pack ?? sizeOnlyFeatures(f.size)) };
      if (pack) {
        withPack++;
        f.sources.push('pack');
      }
      if (row) {
        withTable++;
        f.sources.push('table');
        feats.xrefsIn = pick(row, ['xrefs_in', 'xref_in', 'callers', 'incoming', 'refs_in']) ?? feats.xrefsIn;
        feats.basicBlocks = pick(row, ['basic_blocks', 'blocks', 'bb']) ?? feats.basicBlocks;
        feats.instructions = pick(row, ['instructions', 'insns', 'instruction_count']) ?? feats.instructions;
        if (!pack && (row.eh || row.eh_heavy)) feats.unwindEntries = 2;
      }
      feats.templated = /</.test(f.name ?? '') || undefined;
      f.features = feats;
      f.xrefsIn = feats.xrefsIn;
      f.xrefsOut = pick(row, ['xrefs_out', 'xref_out', 'callees', 'outgoing', 'refs_out']) ?? feats.calls;
      f.basicBlocks = feats.basicBlocks;
      f.instructions = feats.instructions;
      f.branches = feats.condBranches;
    }
    const byModule: Record<string, number> = {};
    for (const f of chosen) byModule[moduleOf(f.unit)] = (byModule[moduleOf(f.unit)] ?? 0) + 1;
    return {
      source: b.source, at: Date.now(), filter, inventory: inv, candidates: b.candidates.length, claimsChecked: b.claimsChecked, excluded,
      selected: chosen.length, selectedBytes: chosen.reduce((s, f) => s + f.size, 0), withPackFeatures: withPack, withTableFacts: withTable,
      units: new Set(chosen.map((f) => f.unit)).size, byModule, functions: chosen,
    };
  }
}
