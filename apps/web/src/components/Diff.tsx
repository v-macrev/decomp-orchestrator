// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal LCS line diff (units are a few hundred lines; O(n·m) is fine).
export function Diff({ before, after }: { before: string; after: string }) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return <pre className="diffview">{after}</pre>;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const rows: Array<{ k: 'add' | 'del' | 'eq'; t: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ k: 'eq', t: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) rows.push({ k: 'del', t: a[i++]! });
    else rows.push({ k: 'add', t: b[j++]! });
  }
  while (i < a.length) rows.push({ k: 'del', t: a[i++]! });
  while (j < b.length) rows.push({ k: 'add', t: b[j++]! });
  return (
    <div className="diffview">
      {rows.map((r, n) => (
        <div key={n} className={r.k === 'eq' ? '' : r.k}>{r.k === 'add' ? '+ ' : r.k === 'del' ? '- ' : '  '}{r.t}</div>
      ))}
    </div>
  );
}
