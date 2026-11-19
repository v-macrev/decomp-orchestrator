// SPDX-License-Identifier: AGPL-3.0-or-later
// Complexity features from a skyrim_decomp local pack (`pack.json`: bytes_hex + instruction
// boundaries + external reference targets + unwind entry count, written by `sr start`).
//
// Only counts leave this module — no bytes, mnemonics or addresses are kept or persisted, so the
// result is safe to store and to show even when the run has no exposure consent.
//
// The decoder is a classifier, not a disassembler: instruction boundaries come from the pack, and
// we only need to recognise branches, calls, indirect control flow and SIMD in the first opcode bytes.
import type { FunctionFeatures } from '@decomp/core';

export interface PackJson {
  bytes_hex: string;
  instructions: Array<{ offset: number; length: number; field: [number, number] | null; target: number | null }>;
  references?: Array<{ target_rva: number; kind: string }>;
  unwind_entries?: number;
  identity?: { size?: number; name_origin?: string | null };
}

type OpKind = 'jcc' | 'jmp' | 'call' | 'icall' | 'ijmp' | 'ret' | 'sse' | 'other';

interface Decoded {
  kind: OpKind;
  /** Relative branch displacement target (offset within the function's byte stream), when direct. */
  rel?: number;
  /** For icall/ijmp: memory operand (mod != 3) and not RIP-relative → vtable-style. */
  viaMemory?: boolean;
  ripRelative?: boolean;
}

const LEGACY_PREFIX = new Set([0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x2e, 0x3e, 0x26, 0x36, 0x64, 0x65]);

function i8(b: number) {
  return b > 127 ? b - 256 : b;
}
function i32(b: Uint8Array, at: number) {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) | 0;
}

export function classifyInstruction(code: Uint8Array, off: number, len: number): Decoded {
  let i = off;
  const end = off + len;
  let mandatory = false;
  while (i < end && LEGACY_PREFIX.has(code[i]!)) {
    if (code[i] === 0x66 || code[i] === 0xf2 || code[i] === 0xf3) mandatory = true;
    i++;
  }
  if (i < end && (code[i]! & 0xf0) === 0x40) i++; // REX
  if (i >= end) return { kind: 'other' };
  const op = code[i]!;
  const next = end; // address of the following instruction (relative branches are from here)
  if (op === 0xc4 || op === 0xc5 || op === 0x62) return { kind: 'sse' }; // VEX / EVEX → AVX/SIMD
  if (op >= 0x70 && op <= 0x7f) return { kind: 'jcc', rel: next + i8(code[i + 1] ?? 0) };
  if (op === 0xe3) return { kind: 'jcc', rel: next + i8(code[i + 1] ?? 0) }; // jrcxz
  if (op === 0xeb) return { kind: 'jmp', rel: next + i8(code[i + 1] ?? 0) };
  if (op === 0xe9) return { kind: 'jmp', rel: next + i32(code, i + 1) };
  if (op === 0xe8) return { kind: 'call', rel: next + i32(code, i + 1) };
  if (op === 0xc3 || op === 0xc2) return { kind: 'ret' };
  if (op === 0xff) {
    const modrm = code[i + 1] ?? 0;
    const reg = (modrm >> 3) & 7;
    const mod = modrm >> 6;
    const rm = modrm & 7;
    const rip = mod === 0 && rm === 5;
    if (reg === 2 || reg === 3) return { kind: 'icall', viaMemory: mod !== 3 && !rip, ripRelative: rip };
    if (reg === 4 || reg === 5) return { kind: 'ijmp', viaMemory: mod !== 3 && !rip, ripRelative: rip };
    return { kind: 'other' };
  }
  if (op === 0x0f) {
    const b = code[i + 1] ?? 0;
    if (b >= 0x80 && b <= 0x8f) return { kind: 'jcc', rel: next + i32(code, i + 2) };
    if (b === 0x1f || b === 0x0b || b === 0x05) return { kind: 'other' }; // nop / ud2 / syscall
    // SSE/SSE2 moves, arithmetic, conversions, compares, shuffles, 3-byte maps (0F38 / 0F3A)
    if ((b >= 0x10 && b <= 0x17) || (b >= 0x28 && b <= 0x2f) || (b >= 0x50 && b <= 0x7f) || b === 0xc2 || b === 0xc6 || b === 0x38 || b === 0x3a || (mandatory && b >= 0xd0)) {
      return { kind: 'sse' };
    }
  }
  return { kind: 'other' };
}

/** Decode a pack into complexity counts. Never throws on odd input: unknown bytes count as "other". */
export function featuresFromPack(pack: PackJson, extra: Partial<FunctionFeatures> = {}): FunctionFeatures {
  const code = Uint8Array.from(Buffer.from(pack.bytes_hex ?? '', 'hex'));
  const size = pack.identity?.size ?? code.length;
  const rows = [...(pack.instructions ?? [])].sort((a, b) => a.offset - b.offset);
  let condBranches = 0, backEdges = 0, calls = 0, indirectCalls = 0, indirectJumps = 0, sseOps = 0;
  let tailCall = false;
  const leaders = new Set<number>([0]);
  rows.forEach((row, idx) => {
    const d = classifyInstruction(code, row.offset, row.length);
    const after = row.offset + row.length;
    const intra = d.rel !== undefined && d.rel >= 0 && d.rel < code.length;
    switch (d.kind) {
      case 'jcc':
        condBranches++;
        if (intra) {
          leaders.add(d.rel!);
          if (d.rel! <= row.offset) backEdges++;
        }
        leaders.add(after);
        break;
      case 'jmp':
        if (intra) {
          leaders.add(d.rel!);
          if (d.rel! <= row.offset) backEdges++;
        } else if (idx === rows.length - 1 || rows.slice(idx + 1).every((r) => code[r.offset] === 0xcc)) tailCall = true;
        leaders.add(after);
        break;
      case 'call':
        calls++;
        break;
      case 'icall':
        if (d.viaMemory) indirectCalls++;
        else calls++; // call [rip+x] (import thunk / function-pointer global) or call reg
        break;
      case 'ijmp':
        if (d.viaMemory || !d.ripRelative) indirectJumps++;
        if (idx === rows.length - 1) tailCall = true;
        leaders.add(after);
        break;
      case 'ret':
        leaders.add(after);
        break;
      case 'sse':
        sseOps++;
        break;
      default:
        break;
    }
  });
  const basicBlocks = [...leaders].filter((o) => o < code.length).length;
  const dataRefs = (pack.references ?? []).filter((r) => r.kind === 'data-or-code').length;
  return {
    source: 'pack', size, instructions: rows.length, basicBlocks, condBranches, backEdges, calls, indirectCalls, indirectJumps, sseOps,
    dataRefs, xrefsIn: null, unwindEntries: pack.unwind_entries ?? null, tailCall, priorFailures: 0, nameConfidence: 'named', cautions: 0,
    ...extra,
  };
}

/** Name confidence from the backlog's name origin (community/sibling names vs guesses). */
export function nameConfidence(name: string | null, origin: string | null | undefined): FunctionFeatures['nameConfidence'] {
  if (!name) return 'unnamed';
  if (origin && /guess|standin|observed/i.test(origin)) return 'guess';
  return 'named';
}
