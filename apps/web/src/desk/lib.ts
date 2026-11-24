// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getToken } from '../api';

export const cn = (...a: ClassValue[]) => twMerge(clsx(a));
export type State = 'verified' | 'uncredited' | 'filed' | 'awaiting' | 'matched' | 'queued' | 'claim' | 'taken' | 'released' | 'flag';

export interface Fn {
  rva: string; va: string; name: string | null; size: number | null; state: State; held: string | null; unit: string | null;
  route: string | null; model: string | null; modelSource: string | null; harness: string | null; attempts: number | null;
  nearAligned: number | null; nearExact: number | null; nearReason: string | null; bytePass: boolean; matchedLocal: boolean;
  reason: string | null; category: string | null; first: number | null; last: number | null; filedAt: number | null;
  pr: number | null; filedSource: string | null; verifiedAt: number | null; upstream: string | null; upstreamOwner: string | null;
  claim: string | null; claimUrl: string | null; difficulty: string | null; run: string | null; passedAt: number | null;
}
export interface Step {
  at: number; end?: number | null; n: number; model: string | null; harness: string | null; status: string; decision: string | null;
  codes: string[]; result: string | null; aligned: number | null; exact: number | null; target: number | null; verdict: string | null; error: string | null;
}
export interface Detail { rva: string; timeline: Step[]; source: { path: string; content: string }[] | null; sourceNote: string | null }
export interface Reason { key: string; label: string; rule: string; count: number; bytes: number }
export interface Summary {
  generatedAt: number; login: string; fetchedAt: number; sha: string; progressUpdatedAt: string; states: Partial<Record<State, number>>; total: number;
  kpi: any; limits: { dailyLimit: number | null; awaitingCap: number | null; prCap: number | null; readyBatch: number | null };
  funnel: Record<'screened' | 'claimed' | 'matched' | 'filed' | 'verified' | 'takenAfterMatch', number>;
  cumulative: { t: number; n: number; bytes: number }[]; hours: { attempts: number[]; passes: number[] }; grid: number[][];
  reasons: Reason[]; heldReasons: Reason[]; flow: { stage: 'm' | 'o'; from: string; to: string; n: number }[];
  facts: string[]; notes: Record<string, string>; localModels: string[]; upstream: any; batches: any[]; runs: any[]; historyRuns: number;
}
export interface Hist { t: number; verified: number; bytes: number; awaiting: number; submissionsToday: number; filed: number; queue: number }

export const STATE: Record<State, { label: string; tone: 'cool' | 'warm' | 'none' | 'line' }> = {
  verified: { label: 'Verified', tone: 'cool' },
  uncredited: { label: 'Matched upstream, uncredited', tone: 'line' },
  filed: { label: 'Filed', tone: 'warm' },
  awaiting: { label: 'Awaiting', tone: 'warm' },
  matched: { label: 'Matched, not filed', tone: 'cool' },
  queued: { label: 'Queued', tone: 'none' },
  claim: { label: 'Open claim', tone: 'none' },
  taken: { label: 'Taken by others', tone: 'line' },
  released: { label: 'Released', tone: 'none' },
  flag: { label: 'Flag report', tone: 'warm' },
};

export const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
export const when = (t: number | null | undefined) =>
  !t ? '—' : new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const dash = (v: string | null | undefined) => v ?? '—';
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function getJson<T>(name: string): Promise<T> {
  const tok = getToken();
  const r = await fetch(`/api/desk/${name}`, { cache: 'no-store', headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${name}: HTTP ${r.status}`);
  return r.json();
}

export function useSummary(enabled: boolean, onChange: (prev: Summary, next: Summary) => void) {
  const [s, set] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<Summary | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => getJson<Summary>('summary').then((n) => {
      if (!live) return;
      setError(null);
      if (last.current?.generatedAt === n.generatedAt) return;
      if (last.current) cb.current(last.current, n);
      last.current = n;
      set(n);
    }).catch((e) => live && setError(String(e.message)));
    load();
    const id = setInterval(load, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [enabled]);
  return { s, error };
}

/** Loads a per-view file, and again whenever the summary's stamp changes. */
export function useFile<T>(name: string | null, stamp: number): T | null {
  const [v, set] = useState<T | null>(null);
  useEffect(() => {
    if (!name) { set(null); return; }
    let live = true;
    getJson<T>(name).then((x) => live && set(x)).catch(() => live && set(null));
    return () => { live = false; };
  }, [name, stamp]);
  return v;
}

export function useWidth() {
  const [w, set] = useState(innerWidth);
  useEffect(() => {
    const f = () => set(innerWidth);
    addEventListener('resize', f);
    return () => removeEventListener('resize', f);
  }, []);
  return w;
}
