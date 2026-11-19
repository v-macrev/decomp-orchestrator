// SPDX-License-Identifier: AGPL-3.0-or-later
// Same estimator as the server's context builder (≈3.3 chars/token for code-heavy text), so skill
// token counts and bundle budgets agree without a tokenizer dependency.
export const CHARS_PER_TOKEN = 3.3;
export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);
/** Hard cap per skill body (the static prefix and dynamic slots are budgeted in multiples of it). */
export const SKILL_TOKEN_CAP = 600;
