// SPDX-License-Identifier: AGPL-3.0-or-later
// Bind hints, the way the repository's drafter card asks a contributor to write them: when
// `sr compare` prints `UNBOUND reference <name>`, the name goes into the task's bind-hints.json
// with "the RVA from the pack's reference table" (docs/drafter-card.md, "Names and binding").
//
// Workers cannot write that file (it lives under SR_LOCAL_DIR, outside the packet's paths), so a
// candidate that loads a string literal or a global could never match, however right its code.
// This pairs each unbound name with a target address deterministically, from what the comparator
// itself produced: its alignment pairs a target instruction with the candidate instruction that
// carries the relocation, and the pack says which address that target instruction references.
// Only addresses the pack lists are ever used, and an ambiguous name is left alone.

export interface PackInstruction {
  offset: number;
  length: number;
}
export interface PackReference {
  target_rva: number;
  at: number[];
}
export interface AlignPair {
  op: string;
  t?: number;
  c?: number;
}

/** Names of `UNBOUND reference <name>: ...` lines in the compare output (thread-locals excluded). */
export function unboundNames(bind: unknown): string[] {
  if (!Array.isArray(bind)) return [];
  const out = new Set<string>();
  for (const line of bind) {
    const m = /^UNBOUND reference (\S+?):?\s/.exec(String(line));
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/** The bind-hints.json path the compare output names for this task, if any. */
export function bindHintsPath(bind: unknown): string | null {
  if (!Array.isArray(bind)) return null;
  for (const line of bind) {
    const m = / to (\S+bind-hints\.json)\s*$/.exec(String(line));
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Candidate relocation names per candidate instruction offset, read from the comparator's private
 * side-by-side listing (`<REL32 name>` after the candidate's instruction).
 */
export function candidateRelocations(sideBySide: string): Map<number, string[]> {
  const lines = sideBySide.split('\n');
  const header = lines.find((l) => /^\s*off\s+target\b/.test(l));
  const out = new Map<number, string[]>();
  if (!header) return out;
  const col = header.indexOf('off', header.indexOf('target'));
  if (col < 0) return out;
  // Offsets are right-aligned under "off": start a few columns early, after the target's padding.
  const from = Math.max(0, col - 5);
  for (const line of lines) {
    if (line.length <= col) continue;
    const m = /^\s+([0-9a-f]+)\s{2,}(\S.*)$/i.exec(line.slice(from));
    if (!m) continue;
    const names = [...m[2]!.matchAll(/<(?:REL32|ADDR64|ADDR32NB|REL32_\d)\s+([^\s>]+)>/g)].map((x) => x[1]!);
    if (names.length) out.set(parseInt(m[1]!, 16), names);
  }
  return out;
}

/** Target addresses referenced by the target instruction at each offset (from the pack). */
export function targetReferences(instructions: PackInstruction[], references: PackReference[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of references) {
    for (const at of r.at) {
      const ins = instructions.find((i) => at >= i.offset && at < i.offset + i.length);
      if (!ins) continue;
      out.set(ins.offset, [...(out.get(ins.offset) ?? []), r.target_rva]);
    }
  }
  return out;
}

/**
 * Hints for the unbound names: name -> "0x<rva>", only where every aligned pair that carries the
 * name points at one and the same pack-listed address.
 */
export function autoBindHints(opts: { unbound: string[]; sideBySide: string; alignment: AlignPair[]; instructions: PackInstruction[]; references: PackReference[] }): Record<string, string> {
  const want = new Set(opts.unbound);
  if (!want.size) return {};
  const relocs = candidateRelocations(opts.sideBySide);
  const targets = targetReferences(opts.instructions, opts.references);
  const seen = new Map<string, Set<number>>();
  for (const p of opts.alignment) {
    if (p.op !== 'pair' || p.t === undefined || p.c === undefined) continue;
    const names = (relocs.get(p.c) ?? []).filter((n) => want.has(n));
    const rvas = targets.get(p.t) ?? [];
    if (names.length !== 1 || rvas.length !== 1) continue;
    const s = seen.get(names[0]!) ?? new Set<number>();
    s.add(rvas[0]!);
    seen.set(names[0]!, s);
  }
  const out: Record<string, string> = {};
  for (const [name, rvas] of seen) if (rvas.size === 1) out[name] = `0x${[...rvas][0]!.toString(16)}`;
  return out;
}
