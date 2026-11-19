// SPDX-License-Identifier: AGPL-3.0-or-later
// SKILL.md on disk: frontmatter (one `key: value` per line; triggers as one JSON line so no YAML
// parser is needed) followed by the markdown body. The database is the source of truth; files are a
// reviewable mirror (git-diffable) and an import path for hand-written skills.
import { SkillTrigger, type SkillStatus } from './schemas.js';
import { describeTrigger } from './matcher.js';

export interface SkillMdDoc {
  id: string;
  name: string;
  description: string;
  version: number;
  status: SkillStatus | 'proposed';
  origin: string;
  tokens: number;
  triggers: SkillTrigger;
  body: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function renderSkillMd(d: SkillMdDoc): string {
  return [
    '---',
    `id: ${d.id}`,
    `name: ${oneLine(d.name)}`,
    `description: ${oneLine(d.description)}`,
    `version: ${d.version}`,
    `status: ${d.status}`,
    `origin: ${d.origin}`,
    `tokens: ${d.tokens}`,
    `triggers: ${JSON.stringify(compactTrigger(d.triggers))}`,
    `# trigger: ${describeTrigger(d.triggers)}`,
    '---',
    '',
    d.body.trim(),
    '',
  ].join('\n');
}

export function parseSkillMd(text: string): SkillMdDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('SKILL.md must start with a --- frontmatter block');
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.name) throw new Error('SKILL.md frontmatter needs a name');
  const triggers = SkillTrigger.parse(meta.triggers ? JSON.parse(meta.triggers) : {});
  return {
    id: meta.id ?? '',
    name: meta.name,
    description: meta.description ?? '',
    version: Number(meta.version ?? 1) || 1,
    status: (meta.status as SkillMdDoc['status']) ?? 'candidate',
    origin: meta.origin ?? 'manual',
    tokens: Number(meta.tokens ?? 0) || 0,
    triggers,
    body: m[2]!.trim(),
  };
}

/** Drop empty groups so the JSON line stays short and diffs stay readable. */
export function compactTrigger(t: SkillTrigger): Partial<SkillTrigger> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (Array.isArray(v) && !v.length) continue;
    if (k === 'minScore' && v === 1) continue;
    if (k === 'features' && !Object.values(v as object).some((x) => x !== undefined)) continue;
    if (k === 'exclude' && !Object.values(v as Record<string, unknown[]>).some((x) => x.length)) continue;
    out[k] = v;
  }
  return out as Partial<SkillTrigger>;
}
