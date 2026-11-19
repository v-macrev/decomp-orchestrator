// SPDX-License-Identifier: AGPL-3.0-or-later
// Skill bodies end up inside worker prompts, and some are synthesised from untrusted text (PR
// review comments) or by a model. Two layers keep that safe:
//   * sanitizeSkillText strips what never belongs in a recipe (URLs, @mentions, provenance RVAs,
//     host paths) before anything is stored;
//   * scanSkillBody rejects bodies that look like prompt injection, advise forbidden techniques
//     (the Gate Keeper's never-list) or carry game-derived bytes / decompiler identifiers.
// Every skill still has to win a shadow evaluation through the real Gate Keeper before activation,
// and the Gate Keeper keeps rejecting cheats regardless of what any skill says.

export interface ScanFinding {
  code: 'INJECTION' | 'FORBIDDEN_ADVICE' | 'LEAK' | 'TOO_LONG' | 'EMPTY';
  message: string;
}

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|contract|instructions?|rules?)\b/i,
  /\b(system prompt|developer message|you are now|act as|new instructions|jailbreak)\b/i,
  /\b(output|reply|respond)\b[^.\n]{0,30}\b(complete files?|whole files?|full files?)\b[^.\n]{0,30}\b(edits mode|always)\b/i,
  /\b(skip|bypass|disable|evade|fool|trick)\b[^.\n]{0,30}\b(gate ?keeper|verifier|compare|leak ?grep|checks?|review)\b/i,
  /<\/?(system|assistant|user|task_spec|retry|skills?|core_skills|repository_rules)\b/i,
];

/** [pattern, what, negatable]: a negatable mention is fine inside a sentence that forbids it. */
const FORBIDDEN: Array<[RegExp, string, boolean]> = [
  [/\b__asm\b|\b__emit\b|\binline assembly\b|__declspec\s*\(\s*naked/i, 'inline assembly', true],
  [/#\s*pragma\s+(?!once\b)\w+/i, '#pragma other than once', true],
  [/\bbyte arrays?\b/i, 'byte arrays / embedded machine code', true],
  [/(?:0x[0-9a-f]{2}\s*,\s*){6,}/i, 'embedded machine code', false],
  [/reinterpret_cast\s*<[^>]*>\s*\(\s*0x[0-9a-f]{6,}/i, 'casting an absolute address', false],
  [/\b(stub|hard-?code)\b[^.\n]{0,30}\b(return|constant|result)\b/i, 'stubbing or faking a result', true],
  [/(tools\/|compare\.py|leakgrep|builds\/target\.json|\.local\/)/i, 'touching verifier inputs', true],
];
const NEGATION = /\b(never|not|no|don't|do not|avoid|without|instead of|rejected|forbidden|must not)\b/i;

/** The sentence around a match (negation is judged per sentence). */
function sentenceAt(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('\n', index - 1)) + 1;
  const ends = [text.indexOf('.', index), text.indexOf('\n', index)].filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

const LEAKS: Array<[RegExp, string]> = [
  [/\b(?:FUN|DAT|LAB|PTR|SUB)_[0-9a-fA-F]{4,}\b|\b(?:param|local|Stack)_[0-9a-fA-F]+\b|\b[iupcbl]Var\d+\b|\bundefined[1-8]\b/, 'decompiler identifiers'],
  [/(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])|(?:[0-9a-fA-F]{2}[ ,:-]){15}[0-9a-fA-F]{2}|(?:\\x[0-9a-fA-F]{2}){6,}/, 'hex/byte run'],
  [/\b0x14[0-9a-f]{7}\b/i, 'absolute image address'],
  [/\/Users\/|\/home\/\w|[A-Za-z]:[\\/]+Users[\\/]/i, 'host path'],
];

/** Mechanical clean-up applied to every drafted body before it is scanned or stored. */
export function sanitizeSkillText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(^|\s)@[A-Za-z0-9-]{2,39}\b/g, '$1')
    // provenance ("Closed X 0x2e73a0", "Seen in Y 0x237a20") costs tokens and teaches nothing
    .replace(/\s*\b(Closed|Seen in|Used for|Fixed in|See)\b[^.\n]*?\b0x[0-9a-f]{4,}\b[^.\n]*\.?/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function scanSkillBody(body: string, maxTokens = 600, estimate: (s: string) => number = (s) => Math.ceil(s.length / 3.3)): ScanFinding[] {
  const out: ScanFinding[] = [];
  if (!body.trim()) return [{ code: 'EMPTY', message: 'empty body' }];
  for (const re of INJECTION) if (re.test(body)) out.push({ code: 'INJECTION', message: `prompt-injection pattern: ${re.source.slice(0, 60)}…` });
  for (const [re, what, negatable] of FORBIDDEN) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of body.matchAll(g)) {
      if (negatable && NEGATION.test(sentenceAt(body, m.index ?? 0))) continue;
      out.push({ code: 'FORBIDDEN_ADVICE', message: `advises a rejected technique: ${what}` });
      break;
    }
  }
  for (const [re, what] of LEAKS) if (re.test(body)) out.push({ code: 'LEAK', message: `contains ${what}` });
  const t = estimate(body);
  if (t > maxTokens) out.push({ code: 'TOO_LONG', message: `${t} tokens > cap ${maxTokens}` });
  return out;
}
