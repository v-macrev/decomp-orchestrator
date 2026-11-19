// SPDX-License-Identifier: AGPL-3.0-or-later
// Output scoping: the Worker never touches the filesystem. It returns file contents; this module
// decides — before anything is written — whether each path is inside the packet's allowlist and
// whether sizes are sane. Rejected outputs are never written, so a hostile path cannot escape.
import type { Finding } from '@decomp/core';

export interface ScopeLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxLineChars: number;
  maxLines: number;
}

export const DEFAULT_SCOPE_LIMITS: ScopeLimits = {
  maxFiles: 4,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 512 * 1024,
  maxLineChars: 600,
  maxLines: 8_000,
};

/** Paths no candidate may ever write (verifier inputs, tooling, CI, records). */
const PROTECTED = [/^tools\//, /^\.github\//, /^builds\//, /^data\//, /^tests\//, /^docs\//, /^site\//, /^specs\//, /^reports\//, /^findings\//, /^sr(\.cmd)?$/, /^reconstruction\/recipes\//, /^reconstruction\/INDEX\.md$/, /^\.[^/]+/];

export function normalisePath(p: string): string | null {
  if (!p || p.includes('\0')) return null;
  if (p.includes('\\')) return null; // never accept backslashes (Windows traversal ambiguity)
  if (/^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('~')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return null;
  return p;
}

export function checkScope(
  files: Array<{ path: string; content: string }>,
  allowed: string[],
  limits: ScopeLimits = DEFAULT_SCOPE_LIMITS,
): { findings: Finding[]; accepted: Array<{ path: string; content: string }> } {
  const f: Finding[] = [];
  const allow = new Set(allowed);
  const accepted: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  if (files.length > limits.maxFiles) {
    f.push({ stage: 'scope', code: 'SCOPE_TOO_MANY_FILES', severity: 'block', message: `${files.length} files returned (max ${limits.maxFiles})` });
  }
  for (const file of files) {
    const p = normalisePath(file.path);
    if (!p) {
      f.push({ stage: 'scope', code: 'SCOPE_PATH_OUTSIDE_ALLOWLIST', severity: 'block', file: file.path.slice(0, 120), message: 'path is absolute, contains traversal or illegal characters' });
      continue;
    }
    if (seen.has(p)) {
      f.push({ stage: 'scope', code: 'SCOPE_DUPLICATE_PATH', severity: 'block', file: p, message: 'path returned twice' });
      continue;
    }
    seen.add(p);
    if (!allow.has(p)) {
      const code = PROTECTED.some((rx) => rx.test(p)) ? 'SCOPE_PROTECTED_PATH' : p.startsWith('reconstruction/') ? 'SCOPE_OTHER_UNIT' : 'SCOPE_PATH_OUTSIDE_ALLOWLIST';
      const why = code === 'SCOPE_PROTECTED_PATH' ? 'verifier inputs, tooling and records are protected' : code === 'SCOPE_OTHER_UNIT' ? 'never edit another unit to force a pass' : 'only the packet unit files may be written';
      f.push({ stage: 'scope', code, severity: 'block', file: p, message: `${p} is not in this packet's allowlist (${allowed.join(', ')}); ${why}` });
      continue;
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    total += bytes;
    if (bytes > limits.maxFileBytes) f.push({ stage: 'scope', code: 'SCOPE_FILE_TOO_LARGE', severity: 'block', file: p, message: `${bytes} bytes (max ${limits.maxFileBytes})` });
    if (/[\0\u0001-\u0008\u000e-\u001f]/.test(file.content)) f.push({ stage: 'scope', code: 'SCOPE_BINARY_CONTENT', severity: 'block', file: p, message: 'control characters in source' });
    const lines = file.content.split('\n');
    if (lines.length > limits.maxLines) f.push({ stage: 'scope', code: 'SCOPE_TOO_MANY_LINES', severity: 'block', file: p, message: `${lines.length} lines (max ${limits.maxLines})` });
    const long = lines.findIndex((l) => l.length > limits.maxLineChars);
    if (long >= 0) f.push({ stage: 'scope', code: 'SCOPE_LINE_TOO_LONG', severity: 'block', file: p, line: long + 1, message: `line exceeds ${limits.maxLineChars} chars` });
    accepted.push({ path: p, content: file.content.replace(/\r\n/g, '\n') });
  }
  if (total > limits.maxTotalBytes) f.push({ stage: 'scope', code: 'SCOPE_TOTAL_TOO_LARGE', severity: 'block', message: `${total} bytes total (max ${limits.maxTotalBytes})` });
  return { findings: f, accepted };
}
