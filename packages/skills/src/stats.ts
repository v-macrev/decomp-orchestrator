// SPDX-License-Identifier: AGPL-3.0-or-later
// Pass-rate lift. The primary control group is the deterministic holdout (eligible packets that
// were deliberately not shown the skill); when it is still too small, fall back to a baseline of
// non-eligible attempts at the same difficulties (confounded, so flagged as such).

export interface LiftInput {
  injected: number;
  injectedPass: number;
  holdout: number;
  holdoutPass: number;
  baseline?: { n: number; pass: number } | null;
}

export interface Lift {
  lift: number | null;
  method: 'holdout' | 'baseline' | 'none';
  /** Standard error of the difference in proportions. */
  se: number | null;
  treated: number;
  control: number;
}

const se2 = (p: number, n: number) => (n > 0 ? (p * (1 - p)) / n : 0);

export function computeLift(i: LiftInput, opts: { minInjected?: number; minHoldout?: number; minBaseline?: number } = {}): Lift {
  const minInjected = opts.minInjected ?? 5;
  const minHoldout = opts.minHoldout ?? 6;
  const minBaseline = opts.minBaseline ?? 20;
  if (i.injected < minInjected) return { lift: null, method: 'none', se: null, treated: i.injected, control: 0 };
  const pt = i.injectedPass / i.injected;
  if (i.holdout >= minHoldout) {
    const pc = i.holdoutPass / i.holdout;
    return { lift: round(pt - pc), method: 'holdout', se: round(Math.sqrt(se2(pt, i.injected) + se2(pc, i.holdout))), treated: i.injected, control: i.holdout };
  }
  if (i.baseline && i.baseline.n >= minBaseline) {
    const pc = i.baseline.pass / i.baseline.n;
    return { lift: round(pt - pc), method: 'baseline', se: round(Math.sqrt(se2(pt, i.injected) + se2(pc, i.baseline.n))), treated: i.injected, control: i.baseline.n };
  }
  return { lift: null, method: 'none', se: null, treated: i.injected, control: i.holdout };
}

/** Negative lift that is unlikely to be noise (one standard error below zero, and material). */
export function clearlyHarmful(l: Lift, minEffect = 0.05): boolean {
  return l.lift !== null && l.se !== null && l.lift <= -minEffect && l.lift + l.se < 0 && l.treated >= 12;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
