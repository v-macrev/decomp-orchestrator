// SPDX-License-Identifier: AGPL-3.0-or-later
// Token estimates for budgeting. Code and listings tokenise denser than prose (~3.3 chars/token
// with current Claude/GPT tokenizers); budgets only need to be consistent, and actual usage is
// always taken from the provider's response.
export const CHARS_PER_TOKEN = 3.3;

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

export function charsFor(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Cut text to a token budget on a line boundary, with a marker. */
export function clipToTokens(text: string, maxTokens: number, marker = '[… trimmed to fit the context budget]'): { text: string; truncated: boolean } {
  const max = charsFor(maxTokens);
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', max - marker.length - 1);
  return { text: `${text.slice(0, cut > max / 2 ? cut : max - marker.length - 1)}\n${marker}`, truncated: true };
}
